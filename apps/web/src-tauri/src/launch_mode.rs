// Copyright 2026 openloomi Team. All rights reserved.
//
// Use of this source code is governed by a license that can be
// found in the LICENSE file in the root of this source tree.

//! Launch-mode detection.
//!
//! Distinguishes between the two ways the desktop app can be brought up:
//!
//! * `Standalone` — the user double-clicked the app icon (or otherwise
//!   launched it directly). The pet is treated as a launcher to the
//!   main dashboard: a left-click on the pet while the agent is busy
//!   pops the main window so the user can keep tabs on what's
//!   happening in chat.
//!
//! * `PluginAgent` — a Claude / Codex / OpenCode plugin started the
//!   desktop app on the user's behalf. The chat is already being run by
//!   the plugin (in the user's terminal / IDE), so surfacing the main
//!   window alongside the pet would create "two dialogs" of the same
//!   conversation. In this mode the pet defaults to the compact status
//!   card; the user can still reach the main window explicitly via the
//!   pet's right-click menu ("Open Loomi") or the card's "Open in
//!   dashboard" CTA.
//!
//! The signal is single-source: the `OPENLOOMI_LAUNCH_MODE` env var,
//! set by each plugin immediately before spawning the desktop process
//! (or, on macOS, by `launchctl setenv` so the value survives the
//! `open -a` hand-off through LaunchServices). It is intentionally
//! orthogonal to `OPENLOOMI_AGENT_PROVIDER` so that the Codex plugin's
//! persistent `codex` choice cannot be clobbered by another plugin
//! that happens to launch the desktop.

/// What context the desktop app was started in.
///
/// Defaults to [`LaunchMode::Standalone`] when the env var is unset or
/// holds an unrecognised value — that matches the long-standing
/// behaviour where every click on the pet opened the main window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchMode {
    /// App was launched by the user directly (icon double-click, OS
    /// auto-start, etc.).
    Standalone,
    /// App was launched by an external plugin that already owns the
    /// chat conversation. Pet click defaults to the compact status
    /// card; the main window is opt-in.
    PluginAgent,
}

/// Reads `OPENLOOMI_LAUNCH_MODE` from the process environment and
/// resolves it to a [`LaunchMode`].
///
/// * `"plugin"`  → [`LaunchMode::PluginAgent`]
/// * anything else (unset, empty, unknown) → [`LaunchMode::Standalone`]
///
/// Pure function. Safe to call from `setup()` and from unit tests.
/// Note that env vars are process-global, so tests that mutate
/// `OPENLOOMI_LAUNCH_MODE` must run serially (not in parallel).
pub fn detect() -> LaunchMode {
    match std::env::var("OPENLOOMI_LAUNCH_MODE").ok().as_deref() {
        Some("plugin") => LaunchMode::PluginAgent,
        _ => LaunchMode::Standalone,
    }
}

/// Short, stable string identifier for use over the Tauri event bus
/// (`pet:launch-mode` payload). Kept in sync with the values the pet
/// webview expects: see `loomi-widget.html`'s `launchMode` variable.
pub fn as_wire_value(mode: LaunchMode) -> &'static str {
    match mode {
        LaunchMode::PluginAgent => "plugin",
        LaunchMode::Standalone => "standalone",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Env-var tests are process-global, so guard mutations behind a
    // mutex and run them serially. Without this, `cargo test` would
    // race when run with `--test-threads>1`.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// RAII guard that restores `OPENLOOMI_LAUNCH_MODE` on drop, so a
    /// failing assertion can't poison subsequent tests.
    struct EnvGuard(Option<String>);
    impl EnvGuard {
        fn new() -> Self {
            EnvGuard(std::env::var("OPENLOOMI_LAUNCH_MODE").ok())
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.0 {
                Some(v) => std::env::set_var("OPENLOOMI_LAUNCH_MODE", v),
                None => std::env::remove_var("OPENLOOMI_LAUNCH_MODE"),
            }
        }
    }

    #[test]
    fn defaults_to_standalone_when_unset() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _g = EnvGuard::new();
        std::env::remove_var("OPENLOOMI_LAUNCH_MODE");
        assert_eq!(detect(), LaunchMode::Standalone);
    }

    #[test]
    fn detects_plugin_mode() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _g = EnvGuard::new();
        std::env::set_var("OPENLOOMI_LAUNCH_MODE", "plugin");
        assert_eq!(detect(), LaunchMode::PluginAgent);
    }

    #[test]
    fn unknown_value_falls_back_to_standalone() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _g = EnvGuard::new();
        std::env::set_var("OPENLOOMI_LAUNCH_MODE", "supervised");
        assert_eq!(detect(), LaunchMode::Standalone);
    }

    #[test]
    fn empty_string_is_standalone() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _g = EnvGuard::new();
        std::env::set_var("OPENLOOMI_LAUNCH_MODE", "");
        assert_eq!(detect(), LaunchMode::Standalone);
    }

    #[test]
    fn wire_value_matches_loomi_widget_contract() {
        assert_eq!(as_wire_value(LaunchMode::PluginAgent), "plugin");
        assert_eq!(as_wire_value(LaunchMode::Standalone), "standalone");
    }
}
