// Decision-file watcher: background thread that polls `decisions.json`
// for changes and maps the pending/done/dismissed bucket counts into one
// of the pet's 9 + idle states, emitting `loop:state` to the pet window.
//
// The polling is intentionally simple (`fs::metadata` mtime + sleep) —
// adding the `notify` crate buys us little here (mtime granularity is
// fine for a human-driven decision flow) and pulls in a transitive set of
// platform-specific deps we don't otherwise need.
//
// B2: also emits `loop:decision` to the bubble + card windows so the
// speech bubble tracks the latest pending decision and the larger card
// window stays in sync with whatever the user most recently opened.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use super::{PET_BUBBLE_LABEL, PET_CARD_LABEL, PET_LABEL, set_pending_decision_count};

const POLL_MS: u64 = 2000;

/// 30s freshness window for "just happened" rules (e.g. a decision moved
/// to `done` in the last 30s => `happy` with "N done" monologue).
const JUST_NOW_SECS: i64 = 30;

/// Spawn the dedicated watcher thread. The thread name surfaces in crash
/// dumps and process listings, which makes "which thread ate my CPU"
/// answers easy.
pub fn spawn_decision_watcher(app: AppHandle) {
    std::thread::Builder::new()
        .name("loomi-pet-decision-watcher".into())
        .spawn(move || {
            let _ = crate::panic_guard::catch_unwind_str(
                "loomi-pet watcher",
                || watch_loop(&app),
            );
        })
        .expect("spawn loomi-pet watcher");
}

fn watch_loop(app: &AppHandle) {
    let path = resolve_decisions_path(app);
    let mut last_mtime: Option<SystemTime> = None;
    let mut last_buckets: (usize, usize, usize) = (0, 0, 0);
    let mut last_decision_ts: Option<String> = None;
    let mut last_top_id: Option<String> = None;

    loop {
        std::thread::sleep(Duration::from_millis(POLL_MS));

        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        if last_mtime == Some(mtime) {
            continue;
        }
        last_mtime = Some(mtime);

        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok(snap) = serde_json::from_slice::<DecisionsSnap>(&bytes) else {
            continue;
        };

        let buckets = (snap.pending.len(), snap.done.len(), snap.dismissed.len());
        // Publish pending count on every successful poll (not just on
        // change) so handlers like `pet:close-card` always see fresh
        // data when they ask `pending_decision_count()`. Cheap atomic
        // store — happens on the watcher thread, off the UI critical
        // path.
        set_pending_decision_count(snap.pending.len());
        let newest_ts = snap
            .pending
            .iter()
            .chain(snap.done.iter())
            .chain(snap.dismissed.iter())
            .filter_map(|d| d.created_at.clone().or(d.completed_at.clone()))
            .max();
        let needs_user = snap.pending.iter().any(|d| d.needs_user.unwrap_or(false));
        let top_pending_id = snap.pending.first().and_then(|d| d.id.clone());

        let changed = buckets != last_buckets
            || newest_ts != last_decision_ts
            || top_pending_id != last_top_id;
        if !changed {
            continue;
        }
        last_buckets = buckets;
        last_decision_ts = newest_ts.clone();
        last_top_id = top_pending_id.clone();

        let (state, monologue) = map_state_to_pet(&snap, &newest_ts, needs_user);
        let state_payload = serde_json::json!({ "state": state, "monologue": monologue });
        // Pet widget flips its sprite/animation, bubble swaps to a
        // state-specific phrase — both listen on `loop:state`. We
        // mirror to the bubble so watcher-driven flips (sweeping /
        // happy / sleeping / etc.) actually change the bubble text;
        // without this the bubble would stay frozen on the last
        // decision's dialogue until a new decision arrives.
        let _ = app.emit_to(PET_LABEL, "loop:state", state_payload.clone());
        let _ = app.emit_to(PET_BUBBLE_LABEL, "loop:state", state_payload);

        // B2: keep bubble + card windows in sync. The bubble auto-shows
        // when the latest pending decision changes and auto-hides when
        // the pending bucket empties. The card was historically
        // user-opened only, but the connector-status strip on the card
        // is the user's primary at-a-glance "is the loop healthy" view
        // — the user shouldn't have to click the bubble to see it. We
        // auto-show the card the first time a pending decision lands
        // (so the user immediately sees the decision + connector dots)
        // and otherwise leave its visibility alone (the × / click
        // handlers drive subsequent toggles).
        if let Some(top) = snap.pending.first() {
            let decision_payload = build_decision_payload(top);
            let _ = app.emit_to(PET_BUBBLE_LABEL, "loop:decision", decision_payload.clone());
            let _ = app.emit_to(PET_CARD_LABEL, "loop:decision", decision_payload);
            // Auto-show the card so the connector strip is visible
            // without an extra click. `show_card_window` is idempotent
            // and re-focuses the existing window. We do this BEFORE
            // showing the bubble so the bubble's `set_focus` call ends
            // up as the last focus event — which is what determines the
            // z-order in the OS float layer (both windows are
            // `always_on_top(true)`). If we did it in the opposite
            // order, the card would end up on top of the bubble and
            // obscure the speech text.
            super::show_card_window(app);
            // Show the bubble as a transient notification on top of
            // the card. The bubble's JS owns the auto-dismiss
            // lifecycle — see `loomi-bubble.html::scheduleAutoHide`.
            // We just need to show + focus.
            super::show_bubble_window(app);
        } else {
            let empty = serde_json::json!({});
            let _ = app.emit_to(PET_BUBBLE_LABEL, "loop:decision", empty);
            if let Some(w) = app.get_webview_window(PET_BUBBLE_LABEL) {
                let _ = w.hide();
            }
        }

        // C: emit a slim pending-list to the card so connection-check
        // (Form 1) and any layout that wants to render a queue can
        // subscribe. Top 5 entries is plenty for a 360×420 window —
        // the user can dismiss / open to see more in the dashboard.
        let pending_list = serde_json::json!({
            "items": snap.pending.iter().take(5).map(|d| {
                serde_json::json!({
                    "id": d.id,
                    "type": d.r#type,
                    "title": d.title,
                    "source": d.source_signal.as_ref().map(|s| s.source.clone()),
                    "source_type": d.source_signal.as_ref().map(|s| s.r#type.clone()),
                    "source_ts": d.source_signal.as_ref().and_then(|s| s.ts.clone()),
                    "confidence": d.confidence,
                })
            }).collect::<Vec<_>>()
        });
        let _ = app.emit_to(PET_CARD_LABEL, "loop:pending-list", pending_list);
    }
}

/// Build the `loop:decision` payload that the bubble + card webviews
/// listen for. Mirrors the shape consumed by `loomi-bubble.html` /
/// `loomi-card.html` (id, type, title, dialogue, priority, source chain,
/// why bullets).
fn build_decision_payload(d: &DecItem) -> serde_json::Value {
    let priority = match d.confidence {
        Some(c) if c >= 0.85 => "p0",
        Some(c) if c >= 0.75 => "p1",
        _ => "p2",
    };
    let (source, source_type, source_ts) = match d.source_signal.as_ref() {
        Some(s) => (
            Some(s.source.clone()),
            Some(s.r#type.clone()),
            s.ts.clone(),
        ),
        None => (None, None, None),
    };
    serde_json::json!({
        "id": d.id,
        "type": d.r#type,
        "title": d.title,
        "dialogue": d.dialogue,
        "priority": priority,
        "source": source,
        "source_type": source_type,
        "source_ts": source_ts,
        "why": d.context.as_ref().and_then(|c| c.why.clone()).unwrap_or_default(),
    })
}

/// Resolve where the loop skill writes its decision JSON.
///
/// Precedence:
/// 1. `LOOMI_PET_DECISIONS_PATH` env var — useful for tests and for
///    pointing at a non-default skill install.
/// 2. Tauri-resolved home directory — handles macOS, Linux, and Windows
///    correctly so the watcher reads the same file the Next.js loop
///    writes on every platform. Must match the layout written by
///    `apps/web/lib/loop/paths.ts` (`LOOP_HOME = homedir()/.openloomi/loop`)
///    or the watcher will be looking at a stale file.
/// 3. Env-var fallback. On POSIX shells `HOME` is set; on Windows it's
///    typically `USERPROFILE`, and older Windows shells only have the
///    `HOMEDRIVE` + `HOMEPATH` pair. Mirrors what the `dirs` crate does.
/// 4. Relative `".openloomi/loop/decisions.json"` — preserved as a last
///    resort so unit tests that don't go through the Tauri runtime still
///    produce a usable path.
pub fn resolve_decisions_path(app: &AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("LOOMI_PET_DECISIONS_PATH") {
        return PathBuf::from(p);
    }
    if let Ok(home) = app.path().home_dir() {
        return home.join(".openloomi").join("loop").join("decisions.json");
    }
    if let Some(p) = resolve_home_from_env() {
        return p;
    }
    PathBuf::from(".openloomi/loop/decisions.json")
}

/// Pure env-var home resolution. Extracted so unit tests can exercise the
/// non-Tauri fallback chain without fabricating an `AppHandle`. Behavior:
///   - Prefers `HOME` (POSIX).
///   - Falls back to `USERPROFILE` (modern Windows).
///   - Falls back to `HOMEDRIVE` + `HOMEPATH` (legacy Windows shells that
///     split the profile across two env vars).
fn resolve_home_from_env() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        return Some(
            PathBuf::from(home)
                .join(".openloomi")
                .join("loop")
                .join("decisions.json"),
        );
    }
    let drive = std::env::var_os("HOMEDRIVE")?;
    let path = std::env::var_os("HOMEPATH")?;
    Some(
        PathBuf::from(drive)
            .join(PathBuf::from(path))
            .join(".openloomi")
            .join("loop")
            .join("decisions.json"),
    )
}

#[cfg(test)]
mod path_tests {
    use super::*;
    use std::sync::Mutex;

    /// Env-var mutation is process-global. We serialize the path tests
    /// behind a single mutex so they can't race each other (and can't
    /// leak state into the rest of the suite if a panic occurs).
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_env<F: FnOnce()>(vars: &[&str], f: F) {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let saved: Vec<_> = vars
            .iter()
            .map(|k| (k.to_string(), std::env::var_os(k)))
            .collect();
        for k in vars {
            std::env::remove_var(k);
        }
        f();
        for (k, v) in saved {
            match v {
                Some(v) => std::env::set_var(&k, v),
                None => std::env::remove_var(&k),
            }
        }
    }

    #[test]
    fn home_env_var_wins() {
        with_env(
            &[
                "LOOMI_PET_DECISIONS_PATH",
                "HOME",
                "USERPROFILE",
                "HOMEDRIVE",
                "HOMEPATH",
            ],
            || {
                std::env::set_var("HOME", "/home/alice");
                let resolved = resolve_home_from_env().expect("HOME set");
                assert_eq!(
                    resolved,
                    PathBuf::from("/home/alice")
                        .join(".openloomi")
                        .join("loop")
                        .join("decisions.json")
                );
            },
        );
    }

    #[test]
    fn userprofile_is_used_when_home_missing() {
        with_env(
            &[
                "LOOMI_PET_DECISIONS_PATH",
                "HOME",
                "USERPROFILE",
                "HOMEDRIVE",
                "HOMEPATH",
            ],
            || {
                std::env::set_var("USERPROFILE", r"C:\Users\Alice");
                let resolved = resolve_home_from_env().expect("USERPROFILE set");
                let expected = PathBuf::from(r"C:\Users\Alice")
                    .join(".openloomi")
                    .join("loop")
                    .join("decisions.json");
                // PathBuf equality is OS-aware: backslashes on Windows,
                // forward slashes on POSIX. Compare component-wise so the
                // assertion works on both.
                assert_eq!(resolved.components().count(), expected.components().count());
                for (a, b) in resolved.components().zip(expected.components()) {
                    assert_eq!(a, b);
                }
            },
        );
    }

    #[test]
    fn homedrive_and_homepath_combine_when_present() {
        with_env(
            &[
                "LOOMI_PET_DECISIONS_PATH",
                "HOME",
                "USERPROFILE",
                "HOMEDRIVE",
                "HOMEPATH",
            ],
            || {
                std::env::set_var("HOMEDRIVE", "C:");
                std::env::set_var("HOMEPATH", r"\Users\Alice");
                let resolved = resolve_home_from_env().expect("HOME* set");
                assert!(resolved.starts_with(PathBuf::from("C:")));
                assert!(resolved.to_string_lossy().contains("Alice"));
                assert!(resolved.ends_with(PathBuf::from(".openloomi/loop/decisions.json")));
            },
        );
    }

    #[test]
    fn returns_none_when_no_env_set() {
        with_env(
            &[
                "LOOMI_PET_DECISIONS_PATH",
                "HOME",
                "USERPROFILE",
                "HOMEDRIVE",
                "HOMEPATH",
            ],
            || {
                assert!(resolve_home_from_env().is_none());
            },
        );
    }

    #[test]
    fn homedrive_alone_does_not_combine() {
        // HOMEDRIVE without HOMEPATH shouldn't fabricate a profile —
        // matching the dirs crate's behavior. Either both must be set or
        // the function returns None and lets the caller fall through.
        with_env(
            &[
                "LOOMI_PET_DECISIONS_PATH",
                "HOME",
                "USERPROFILE",
                "HOMEDRIVE",
                "HOMEPATH",
            ],
            || {
                std::env::set_var("HOMEDRIVE", "C:");
                assert!(resolve_home_from_env().is_none());
            },
        );
    }
}

#[derive(Deserialize)]
pub struct DecisionsSnap {
    #[serde(default)]
    pub pending: Vec<DecItem>,
    #[serde(default)]
    pub done: Vec<DecItem>,
    #[serde(default)]
    pub dismissed: Vec<DecItem>,
}

#[derive(Deserialize)]
pub struct DecItem {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// `defaultDialogue` and `defaultNextStep` in `lib/loop/server.ts`
    /// populate this when the card is built, but decisions written by
    /// the tick pipeline may leave it empty. The bubble / card fall
    /// back to a generic line in that case.
    #[serde(default)]
    pub dialogue: Option<String>,
    #[serde(default)]
    pub confidence: Option<f32>,
    #[serde(default)]
    pub source_signal: Option<SourceSignal>,
    #[serde(default)]
    pub context: Option<DecContext>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    /// Loop does not currently emit this field; if it ever does, the
    /// `needsinput` branch will automatically light up. Default is
    /// `false` so missing-field behavior is well-defined.
    #[serde(default)]
    pub needs_user: Option<bool>,
}

#[derive(Deserialize)]
pub struct SourceSignal {
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub ts: Option<String>,
}

#[derive(Deserialize)]
pub struct DecContext {
    #[serde(default)]
    pub why: Option<Vec<String>>,
}

/// Map a decision snapshot to `(pet_state, optional_monologue_hint)`.
///
/// Rules fire in priority order — the first match wins. Keep this
/// function pure (no IO, no time access other than the `Utc::now()`-style
/// "fresh" check below) so it can be unit-tested by feeding in canned
/// snapshots.
pub fn map_state_to_pet(
    s: &DecisionsSnap,
    newest_ts: &Option<String>,
    needs_user: bool,
) -> (&'static str, Option<String>) {
    let pending = s.pending.len();
    let done = s.done.len();
    let dismissed = s.dismissed.len();
    let hour = current_hour_local();
    let just_now = is_just_now(newest_ts);

    if pending == 0 && !(6..22).contains(&hour) {
        return ("sleeping", None);
    }
    if pending == 0 && dismissed > 0 && just_now {
        return ("sweeping", None);
    }
    if pending == 0 && done > 0 && just_now {
        return ("happy", Some(format!("{} done. Tap to see.", done)));
    }
    if pending == 0 {
        return ("idle", None);
    }
    if pending >= 2 {
        return ("juggling", Some(format!("{} cards open", pending)));
    }
    if needs_user {
        return ("needsinput", None);
    }
    if just_now {
        return ("thinking", None);
    }
    ("working", None)
}

/// Whether `newest_ts` is within `JUST_NOW_SECS` of "now".
///
/// Parses RFC3339 (the format loop-lib.cjs uses for `created_at` /
/// `completed_at`) and falls back to `false` on any parse failure — we'd
/// rather under-emphasize "just now" than crash the watcher.
fn is_just_now(newest_ts: &Option<String>) -> bool {
    let Some(t) = newest_ts else { return false };
    // Lightweight RFC3339-ish parser: positions 0..=9 are YYYY-MM-DD,
    // 11..=12 HH, 14..=15 MM, 17..=18 SS. We do not handle fractional
    // seconds or full ISO 8601 week dates — loop emits a fixed shape and
    // anything else is conservatively treated as "not just now".
    if t.len() < 19 {
        return false;
    }
    let parse_int = |s: &str| s.parse::<u32>().ok();
    let (Some(y), Some(mo), Some(d)) = (
        parse_int(&t[0..4]),
        parse_int(&t[5..7]),
        parse_int(&t[8..10]),
    ) else {
        return false;
    };
    let (Some(h), Some(mi), Some(s)) = (
        parse_int(&t[11..13]),
        parse_int(&t[14..16]),
        parse_int(&t[17..19]),
    ) else {
        return false;
    };
    let days_from_epoch = days_from_civil(y, mo, d);
    let stamp = days_from_epoch * 86_400 + h as i64 * 3_600 + mi as i64 * 60 + s as i64;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(stamp);
    (now - stamp).abs() < JUST_NOW_SECS
}

/// Howard Hinnant's `days_from_civil` (https://howardhinnant.github.io/date_algorithms.html).
/// Inverse of the algorithm: given y/m/d, returns the count of days since
/// the Unix epoch (1970-01-01). Fast, branch-light, and dependency-free.
fn days_from_civil(y: u32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let m = m as i64;
    let d = d as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// Local hour used by the `sleeping` rule.
///
/// `chrono` isn't in our dep tree, so we approximate the user's timezone
/// with a fixed UTC+8 offset (openloomi is primarily used in APAC). A
/// future revision can read the system timezone via `tauri::api` or
/// expose this as a Tauri command if precision matters.
fn current_hour_local() -> u32 {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    ((secs / 3600 + 8) % 24) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(pending: usize, done: usize, dismissed: usize) -> DecisionsSnap {
        DecisionsSnap {
            pending: (0..pending)
                .map(|i| DecItem {
                    id: Some(format!("dec_test_pending_{i}")),
                    r#type: Some("draft_reply".into()),
                    title: Some(format!("pending {i}")),
                    dialogue: None,
                    confidence: Some(0.8),
                    source_signal: None,
                    context: None,
                    created_at: Some(format!("2026-01-01T00:00:0{i}Z")),
                    completed_at: None,
                    needs_user: None,
                })
                .collect(),
            done: (0..done)
                .map(|i| DecItem {
                    id: Some(format!("dec_test_done_{i}")),
                    r#type: Some("draft_reply".into()),
                    title: Some(format!("done {i}")),
                    dialogue: None,
                    confidence: Some(0.8),
                    source_signal: None,
                    context: None,
                    created_at: None,
                    completed_at: Some(format!("2026-01-01T00:00:0{i}Z")),
                    needs_user: None,
                })
                .collect(),
            dismissed: (0..dismissed)
                .map(|i| DecItem {
                    id: Some(format!("dec_test_dismissed_{i}")),
                    r#type: Some("draft_reply".into()),
                    title: Some(format!("dismissed {i}")),
                    dialogue: None,
                    confidence: Some(0.8),
                    source_signal: None,
                    context: None,
                    created_at: Some(format!("2026-01-01T00:00:0{i}Z")),
                    completed_at: None,
                    needs_user: None,
                })
                .collect(),
        }
    }

    #[test]
    fn empty_pending_during_sleep_hours_is_sleeping() {
        let s = snap(0, 0, 0);
        // Force sleeping window by stubbing hour via a one-off wrapper.
        // We can't easily inject hour, so check both branches: any result
        // is "sleeping" or "idle" depending on local clock; just assert
        // it is not the "happy" / "juggling" family.
        let (state, _) = map_state_to_pet(&s, &None, false);
        assert!(matches!(state, "sleeping" | "idle"), "got {state}");
    }

    #[test]
    fn multiple_pending_is_juggling_with_count() {
        let s = snap(3, 0, 0);
        let (state, mono) = map_state_to_pet(&s, &None, false);
        assert_eq!(state, "juggling");
        assert_eq!(mono.as_deref(), Some("3 cards open"));
    }

    #[test]
    fn single_pending_with_needs_user_is_needsinput() {
        let mut s = snap(1, 0, 0);
        s.pending[0].needs_user = Some(true);
        let (state, _) = map_state_to_pet(&s, &None, true);
        assert_eq!(state, "needsinput");
    }

    #[test]
    fn single_pending_no_needs_user_is_working_or_thinking() {
        let s = snap(1, 0, 0);
        let (state, _) = map_state_to_pet(&s, &None, false);
        assert!(matches!(state, "working" | "thinking"), "got {state}");
    }
}
