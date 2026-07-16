use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use super::{PET_BUBBLE_LABEL, PET_LABEL};

#[derive(Clone, Debug, PartialEq, Eq)]
struct VisualState {
    state: String,
    monologue: Option<String>,
    // #365 — extra metadata the widget / card read from `loop:state`
    // without needing a separate event channel. `enabled` mirrors the
    // user's loop on/off toggle (from `pet-config.json`) so the idle
    // pill can switch its colour from green (live) to grey (paused).
    // `last_polled_at` is the ISO timestamp of the most recent watcher
    // poll and powers the compact card's "Last checked: …" line.
    // Both default to the neutral value when a caller doesn't pass
    // them — runtime chat overrides don't carry these fields and
    // neither does the needs-setup bootstrap emit.
    enabled: bool,
    last_polled_at: Option<String>,
}

impl VisualState {
    fn new(state: impl Into<String>, monologue: Option<String>) -> Self {
        Self {
            state: state.into(),
            monologue,
            enabled: true,
            last_polled_at: None,
        }
    }

    fn new_with_meta(
        state: impl Into<String>,
        monologue: Option<String>,
        enabled: bool,
        last_polled_at: Option<String>,
    ) -> Self {
        Self {
            state: state.into(),
            monologue,
            enabled,
            last_polled_at,
        }
    }
}

#[derive(Debug)]
struct StateCoordinator {
    baseline: VisualState,
    runtime: Option<VisualState>,
}

impl Default for StateCoordinator {
    fn default() -> Self {
        Self {
            baseline: VisualState::new("idle", None),
            runtime: None,
        }
    }
}

impl StateCoordinator {
    fn publish_baseline(&mut self, next: VisualState) -> Option<VisualState> {
        self.baseline = next.clone();
        self.runtime.is_none().then_some(next)
    }

    fn publish_runtime(&mut self, next: Option<VisualState>) -> VisualState {
        self.runtime = next;
        self.runtime
            .clone()
            .unwrap_or_else(|| self.baseline.clone())
    }
}

#[derive(Deserialize)]
struct RuntimeStatePayload {
    state: String,
    #[serde(default)]
    monologue: Option<String>,
}

static STATE_COORDINATOR: OnceLock<Mutex<StateCoordinator>> = OnceLock::new();

fn coordinator() -> &'static Mutex<StateCoordinator> {
    STATE_COORDINATOR.get_or_init(|| Mutex::new(StateCoordinator::default()))
}

fn emit_state(app: &AppHandle, state: &VisualState) {
    // #365 — the widget's idle pill and the card's compact view both
    // need `enabled` + `last_polled_at`. They're optional on the
    // payload (callers that don't know the values simply omit them)
    // so older JS keeps working.
    let mut payload = serde_json::json!({
        "state": state.state,
        "monologue": state.monologue,
        "enabled": state.enabled,
    });
    if let Some(obj) = payload.as_object_mut() {
        if let Some(ts) = state.last_polled_at.as_ref() {
            obj.insert("last_polled_at".into(), serde_json::Value::String(ts.clone()));
        }
    }
    let _ = app.emit_to(PET_LABEL, "loop:state", payload.clone());
    let _ = app.emit_to(PET_BUBBLE_LABEL, "loop:state", payload);
}

fn is_supported_runtime_state(state: &str) -> bool {
    matches!(
        state,
        "idle" | "thinking" | "working" | "juggling" | "happy" | "presenting" | "needsinput"
    )
}

/// Update the background state derived from Loop decisions. Active chat work
/// temporarily owns the sprite, but the latest baseline is retained and
/// restored as soon as the runtime bridge releases its override.
pub fn publish_baseline_state(
    app: &AppHandle,
    state: impl Into<String>,
    monologue: Option<String>,
) {
    publish_baseline_state_with_meta(app, state, monologue, true, None);
}

/// #365 — extended variant that also publishes the loop on/off flag
/// and the watcher's most recent poll timestamp. Used by
/// `watcher::publish_baseline_state` so the widget's idle pill and
/// the card's compact view can read a single `loop:state` payload
/// without subscribing to additional events.
pub fn publish_baseline_state_with_meta(
    app: &AppHandle,
    state: impl Into<String>,
    monologue: Option<String>,
    enabled: bool,
    last_polled_at: Option<String>,
) {
    let next = VisualState::new_with_meta(state, monologue, enabled, last_polled_at);
    let effective = coordinator()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .publish_baseline(next);
    if let Some(effective) = effective {
        emit_state(app, &effective);
    }
}

/// Apply a state emitted by the chat UI. `idle` is a release signal rather
/// than a permanent override: it restores the latest Loop-derived baseline.
pub fn handle_runtime_state_event(app: &AppHandle, payload: &str) -> Result<(), String> {
    let payload: RuntimeStatePayload =
        serde_json::from_str(payload).map_err(|error| error.to_string())?;
    let state = payload.state.trim();
    if !is_supported_runtime_state(state) {
        return Err(format!("unsupported pet runtime state: {state}"));
    }

    let next = if state == "idle" {
        None
    } else {
        Some(VisualState::new(state, payload.monologue))
    };
    let effective = coordinator()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .publish_runtime(next);
    emit_state(app, &effective);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_state_overrides_baseline_updates() {
        let mut state = StateCoordinator::default();
        assert_eq!(
            state.publish_runtime(Some(VisualState::new("working", None))),
            VisualState::new("working", None)
        );
        assert_eq!(
            state.publish_baseline(VisualState::new("sleeping", None)),
            None
        );
    }

    #[test]
    fn releasing_runtime_restores_latest_baseline() {
        let mut state = StateCoordinator::default();
        state.publish_runtime(Some(VisualState::new("thinking", None)));
        state.publish_baseline(VisualState::new("needsinput", Some("Review me".into())));

        assert_eq!(
            state.publish_runtime(None),
            VisualState::new("needsinput", Some("Review me".into()))
        );
    }

    #[test]
    fn new_with_meta_preserves_extra_fields() {
        let v = VisualState::new_with_meta(
            "idle",
            None,
            false,
            Some("2026-07-16T12:00:00Z".into()),
        );
        assert_eq!(v.state, "idle");
        assert_eq!(v.monologue, None);
        assert!(!v.enabled);
        assert_eq!(v.last_polled_at.as_deref(), Some("2026-07-16T12:00:00Z"));
    }

    #[test]
    fn new_defaults_to_enabled_and_no_timestamp() {
        let v = VisualState::new("idle", None);
        assert!(v.enabled);
        assert!(v.last_polled_at.is_none());
    }

    #[test]
    fn runtime_state_allowlist_rejects_background_only_states() {
        assert!(is_supported_runtime_state("juggling"));
        assert!(!is_supported_runtime_state("sleeping"));
        assert!(!is_supported_runtime_state("needs-setup"));
    }
}
