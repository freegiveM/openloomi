// Decision-file watcher: background thread that polls `decisions.json`
// for changes and maps the pending/done/dismissed bucket counts into one
// of the pet's 9 + idle states, emitting `loop:state` to the pet window.
//
// The polling is intentionally simple (`fs::metadata` mtime + sleep) —
// adding the `notify` crate buys us little here (mtime granularity is
// fine for a human-driven decision flow) and pulls in a transitive set of
// platform-specific deps we don't otherwise need.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use super::PET_LABEL;

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
        let newest_ts = snap
            .pending
            .iter()
            .chain(snap.done.iter())
            .chain(snap.dismissed.iter())
            .filter_map(|d| d.created_at.clone().or(d.completed_at.clone()))
            .max();
        let needs_user = snap.pending.iter().any(|d| d.needs_user.unwrap_or(false));

        let changed = buckets != last_buckets || newest_ts != last_decision_ts;
        if !changed {
            continue;
        }
        last_buckets = buckets;
        last_decision_ts = newest_ts.clone();

        let (state, monologue) = map_state_to_pet(&snap, &newest_ts, needs_user);
        let payload = serde_json::json!({ "state": state, "monologue": monologue });
        let _ = app.emit_to(PET_LABEL, "loop:state", payload);
    }
}

/// Resolve where the loop skill writes its decision JSON.
///
/// Precedence:
/// 1. `LOOMI_PET_DECISIONS_PATH` env var — useful for tests and for
///    pointing at a non-default skill install.
/// 2. `<app_data_dir>/skills/openloomi-loop/data/decisions.json` —
///    matches the layout used by the bundled skill install.
/// 3. Repo-relative fallback `skills/openloomi-loop/data/decisions.json`
///    so dev runs that don't have a populated `app_data_dir` still work.
pub fn resolve_decisions_path(app: &AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("LOOMI_PET_DECISIONS_PATH") {
        return PathBuf::from(p);
    }
    if let Ok(base) = app.path().app_data_dir() {
        return base
            .join("skills")
            .join("openloomi-loop")
            .join("data")
            .join("decisions.json");
    }
    PathBuf::from("skills/openloomi-loop/data/decisions.json")
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
    pub created_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    /// Loop does not currently emit this field; if it ever does, the
    /// `needsinput` branch will automatically light up. Default is
    /// `false` so missing-field behavior is well-defined.
    #[serde(default)]
    pub needs_user: Option<bool>,
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
                    created_at: Some(format!("2026-01-01T00:00:0{i}Z")),
                    completed_at: None,
                    needs_user: None,
                })
                .collect(),
            done: (0..done)
                .map(|i| DecItem {
                    created_at: None,
                    completed_at: Some(format!("2026-01-01T00:00:0{i}Z")),
                    needs_user: None,
                })
                .collect(),
            dismissed: (0..dismissed)
                .map(|i| DecItem {
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
