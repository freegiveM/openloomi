// Pet window lifecycle: create, show, hide, exit-cleanup, and the
// `CloseRequested` -> `hide()` interception so the traffic-light / × button
// acts as "put away" rather than "destroy the widget".

use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::PET_LABEL;

const PET_W: f64 = 168.0;
const PET_H: f64 = 168.0;

/// AppHandle captured at `build_pet_window` time so the lifecycle
/// shutdown path (which has no `AppHandle` argument) can still reach
/// the pet. Tauri `AppHandle` is cheap to clone, so the second clone
/// here is a no-op.
static PET_APP_HANDLE: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

fn pet_handle_slot() -> &'static Mutex<Option<AppHandle>> {
    PET_APP_HANDLE.get_or_init(|| Mutex::new(None))
}

/// Build the pet window if it does not already exist.
///
/// Called once from `setup()`. We pass `visible(false).focused(false)` so
/// the first frame reads localStorage (position) and paints at the right
/// spot without flashing the default 0,0 position the user would otherwise
/// see for a single frame. Visibility is opted into via `show_pet_window`.
pub fn build_pet_window(app: &AppHandle) -> tauri::Result<()> {
    if let Ok(mut guard) = pet_handle_slot().lock() {
        *guard = Some(app.clone());
    }
    if app.get_webview_window(PET_LABEL).is_some() {
        return Ok(());
    }
    // `drag_and_drop` only exists on Windows in the webview builder
    // (line 716 of webview_window.rs is `#[cfg(windows)]`). On macOS
    // and Linux the API is unavailable, so we gate the call to keep
    // the build green everywhere while still opting out of OS file
    // drop targets where supported.
    //
    // We do NOT call `.visible(false)` here — the pet is the
    // always-resident entry point, so it should be on screen from
    // first launch. `tauri.conf.json` sets `visible: true` for the
    // same reason; the builder matches.
    #[cfg(windows)]
    let builder = WebviewWindowBuilder::new(
        app,
        PET_LABEL,
        WebviewUrl::App("loomi-widget.html".into()),
    )
    .title("Loomi")
    .inner_size(PET_W, PET_H)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .visible(true)
    .focused(false)
    .drag_and_drop(false);

    #[cfg(not(windows))]
    let builder = WebviewWindowBuilder::new(
        app,
        PET_LABEL,
        WebviewUrl::App("loomi-widget.html".into()),
    )
    .title("Loomi")
    .inner_size(PET_W, PET_H)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .visible(true)
    .focused(false);

    builder.build()?;
    wire_pet_window_events(app);
    Ok(())
}

/// Make the pet visible and bring it to the front.
///
/// Re-applies `always_on_top` on every show because some WMs will quietly
/// demote the window on focus loss to a child desktop; the property is
/// cheap to set and protects against drift.
pub fn show_pet_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PET_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.set_always_on_top(true);
    }
}

/// Hide the pet without destroying the webview. The browser process keeps
/// its localStorage state (drag position), so re-showing lands the pet
/// exactly where the user left it.
pub fn hide_pet_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PET_LABEL) {
        let _ = w.hide();
    }
}

/// Genuinely destroy the pet window during app shutdown. Distinct from
/// `hide_pet_window` (which is the user "put it away" gesture) — this is
/// the cleanup that pairs with the main window going away for good.
pub fn close_pet_for_exit(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PET_LABEL) {
        let _ = w.close();
    }
}

/// Cleanup-time entry point that doesn't need an `AppHandle` argument.
///
/// The pet's own `CloseRequested` handler in `wire_pet_window_events`
/// already calls `hide_pet_window`, but during full shutdown we want a
/// real close. `lifecycle::run_cleanup` calls into this so the pet
/// window doesn't outlive the Node sidecar it's talking to.
pub fn close_pet_for_exit_if_open() {
    let Some(handle) = pet_handle_slot().lock().ok().and_then(|g| g.clone()) else {
        return;
    };
    close_pet_for_exit(&handle);
}

/// Interpose on the OS close request: prevent the default close, then
/// hide instead. Mirrors the main window's `close_behavior::decide` pattern
/// — the pet is a tray-style widget, not a regular document window.
fn wire_pet_window_events(app: &AppHandle) {
    let Some(w) = app.get_webview_window(PET_LABEL) else {
        return;
    };
    let app_handle = app.clone();
    w.on_window_event(move |ev| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
            api.prevent_close();
            hide_pet_window(&app_handle);
        }
    });
}
