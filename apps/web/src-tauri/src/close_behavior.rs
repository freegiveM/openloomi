// Close-behavior decision hub.
//
// Every window-close / app-quit entry point flows through here. Keeping the
// policy in one function means future tweaks (per-source policy, config toggle,
// platform differences) have a single place to change, and callers stay dumb.
//
// Current policy (hard-coded, no config toggle):
//   - WindowClose  (red light / × button / Cmd+W / Alt+F4) -> Hide to tray
//       (falls back to Quit if the tray is unavailable, so we never leave the
//        user with a hidden window and no way back in)
//   - ExplicitQuit (tray "Quit", Cmd+Q)                     -> Real exit

use crate::lifecycle;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, WebviewWindow};

/// Whether the system tray was successfully built. If not, hiding the window to
/// tray would leave the user with no way back in, so we fall back to a real
/// exit on window close. Set by `tray::build_tray` during setup.
static TRAY_AVAILABLE: AtomicBool = AtomicBool::new(false);

/// Mark the tray as available. Called once `build_tray` succeeds.
pub(crate) fn mark_tray_available() {
    TRAY_AVAILABLE.store(true, Ordering::SeqCst);
}

/// Where a close request originated from.
#[derive(Clone, Copy)]
pub enum CloseSource {
    /// Native window close: traffic light / × / Cmd+W / Alt+F4.
    WindowClose,
    /// An explicit, intentional quit request (tray "Quit", Cmd+Q).
    ExplicitQuit,
}

/// The resolved action to take for a close request.
#[derive(Clone, Copy)]
pub enum CloseAction {
    /// Hide the window to the tray; the app keeps running.
    Hide,
    /// Fully shut down and exit the app.
    Quit,
}

/// Decide what to do for a close request coming from `source`.
///
/// Policy: hide to tray on window close, real exit on explicit quit — but only
/// if the tray is available. Without a tray there is no way back from a hidden
/// window, so we degrade to a real exit.
pub fn decide(_app: &AppHandle, source: CloseSource) -> CloseAction {
    let tray_available = TRAY_AVAILABLE.load(Ordering::SeqCst);
    match (source, tray_available) {
        (CloseSource::WindowClose, true) => CloseAction::Hide,
        (CloseSource::WindowClose, false) => CloseAction::Quit,
        (CloseSource::ExplicitQuit, _) => CloseAction::Quit,
    }
}

/// Execute a resolved close action.
///
/// Callers are responsible for calling `api.prevent_close()` themselves when the
/// action is `Hide` (Tauri requires it on the `CloseRequested` handler, which we
/// cannot reach from here).
pub fn execute(app: &AppHandle, window: &WebviewWindow, action: CloseAction) {
    match action {
        CloseAction::Hide => {
            println!("📴 Close requested: minimizing to tray");
            if let Err(e) = window.hide() {
                eprintln!("⚠️  Failed to hide window: {}", e);
            }
        }
        CloseAction::Quit => {
            // Just signal exit; the real cleanup runs once in the
            // `RunEvent::ExitRequested` handler. Keeps this non-blocking.
            lifecycle::request_exit(app);
        }
    }
}
