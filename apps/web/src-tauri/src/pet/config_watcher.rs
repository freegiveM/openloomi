// Loomi Pet — `pet-config.json` + custom-theme directory watcher.
//
// We use `notify` (a tiny, well-maintained cross-platform filesystem
// watcher) to listen for external edits of the user's config file
// and theme sprites. On any change we re-read the config from disk
// and emit `pet:config-changed` so the widget can swap sprites
// without a restart.
//
// Two watches:
//   * `pet-config.json` (non-recursive) — the single config file.
//   * `pet-custom/`      (recursive)    — every subdirectory the
//                                         user might drop a custom
//                                         theme into.
//
// We debounce events with a 250 ms timer — editors that write the
// file in two passes (truncate + rename, or atomic-rename with a
// sibling .tmp) fire several raw events, and we only want one
// notification per real edit.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use super::PET_LABEL;
use super::theme;

const DEBOUNCE_MS: u64 = 250;

/// Spawn a daemon thread that watches the pet config + custom
/// themes directory. The thread runs for the lifetime of the
/// process; no shutdown signal is exposed (the watcher terminates
/// with the process).
pub fn spawn_config_watcher(app: AppHandle) {
    std::thread::Builder::new()
        .name("loomi-pet-config-watcher".into())
        .spawn(move || {
            let _ = crate::panic_guard::catch_unwind_str(
                "loomi-pet config watcher",
                || watch_loop(&app),
            );
        })
        .expect("spawn loomi-pet config watcher");
}

fn watch_loop(app: &AppHandle) {
    let config_path = theme::config_path(app);

    // Make sure both paths exist before attaching watches — notify
    // // is happy with non-existent paths in some platforms but
    // // barfs on others. Re-resolve custom_themes_dir on every
    // // iteration so an out-of-band edit to `customThemesDir`
    // // is honored without a restart.
    if let Some(parent) = config_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();

    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[loomi-pet/config-watcher] failed to create watcher: {e}");
            return;
        }
    };

    if let Err(e) = watcher.watch(&config_path, RecursiveMode::NonRecursive) {
        eprintln!(
            "[loomi-pet/config-watcher] failed to watch config {}: {e}",
            config_path.display()
        );
    }

    let mut current_themes_dir: Option<PathBuf> = None;
    let mut last_emit = Instant::now() - Duration::from_millis(DEBOUNCE_MS * 2);
    let mut primed = false;

    loop {
        // Refresh themes-dir watch on every iteration so config edits
        // that move the custom directory get picked up.
        let cfg = theme::read_config(app);
        let themes_dir = cfg.custom_themes_path();
        if current_themes_dir.as_ref() != Some(&themes_dir) {
            if let Some(prev) = &current_themes_dir {
                let _ = watcher.unwatch(prev);
            }
            let _ = std::fs::create_dir_all(&themes_dir);
            if let Err(e) = watcher.watch(&themes_dir, RecursiveMode::Recursive) {
                eprintln!(
                    "[loomi-pet/config-watcher] failed to watch themes dir {}: {e}",
                    themes_dir.display()
                );
            }
            current_themes_dir = Some(themes_dir);
        }

        let recv = match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(r) => r,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // On the first iteration (right after the watch is
                // attached) we want to send an initial config-changed
                // event so the widget can paint with fresh state
                // without waiting for the user's first edit. We do
                // this exactly once.
                if !primed {
                    primed = true;
                    emit_config_changed(app, &cfg);
                    last_emit = Instant::now();
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };

        let event = match recv {
            Ok(ev) => ev,
            Err(e) => {
                eprintln!("[loomi-pet/config-watcher] recv error: {e}");
                continue;
            }
        };
        if !matches!(
            event.kind,
            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
        ) {
            continue;
        }
        // Debounce: skip events that arrive within 250 ms of the
        // previous emit so a single editor save fires one event.
        if last_emit.elapsed() < Duration::from_millis(DEBOUNCE_MS) {
            continue;
        }
        last_emit = Instant::now();
        emit_config_changed(app, &theme::read_config(app));
    }
}

fn emit_config_changed(app: &AppHandle, cfg: &theme::PetConfig) {
    let custom = theme::list_custom_themes(cfg);
    let view = theme::build_view(cfg.clone(), custom);
    let payload = match serde_json::to_value(&view) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[loomi-pet/config-watcher] failed to serialize PetConfigView: {e}"
            );
            return;
        }
    };
    let _ = app.emit_to(PET_LABEL, "pet:config-changed", payload);
}