// Decision card window: larger always-on-top webview shown on demand
// (typically by clicking the bubble or the pet itself while there is a
// pending decision). Loads `public/loomi-card.html` which provides a
// full decision card with Open / Dismiss / Run-in-dashboard actions.
//
// Unlike the bubble, the card is *not* managed by the watcher — the
// host only shows it in response to a user gesture (`pet:open-card` from
// the bubble, or `pet:open-dashboard` from the pet's click handler when
// there is a pending decision). Hide is triggered by either the card's
// own × button (`pet:close-card`) or the host when there are no more
// pending decisions.

use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use super::PET_CARD_LABEL;
use crate::constants;

/// Logical (CSS) width of the card window. Matches `--card-w` in
/// `loomi-card.html`.
pub const CARD_W: f64 = 360.0;
/// Logical (CSS) height of the card window. Matches `--card-h`.
pub const CARD_H: f64 = 420.0;

static CARD_APP_HANDLE: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

fn card_handle_slot() -> &'static Mutex<Option<AppHandle>> {
    CARD_APP_HANDLE.get_or_init(|| Mutex::new(None))
}

/// Build the card window if it doesn't exist yet. Idempotent.
pub fn build_card_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Ok(mut g) = card_handle_slot().lock() {
        *g = Some(app.clone());
    }
    if let Some(w) = app.get_webview_window(PET_CARD_LABEL) {
        return Ok(w);
    }
    let base = WebviewWindowBuilder::new(
        app,
        PET_CARD_LABEL,
        WebviewUrl::App("loomi-card.html".into()),
    )
    .initialization_script(&constants::api_init_script())
    .title("Loomi · card")
    .inner_size(CARD_W, CARD_H)
    .min_inner_size(CARD_W, CARD_H)
    .max_inner_size(CARD_W, CARD_H)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .shadow(false)
    .visible(false)
    .focused(false);
    // `drag_and_drop` is only present on the Windows webview builder, so
    // we gate the call to keep the build green everywhere. On macOS /
    // Linux the OS file-drop target still gets opted out via the
    // window's runtime configuration, but for the card (a transient
    // action surface) this is a non-issue.
    #[cfg(windows)]
    let builder = base.drag_and_drop(false);
    #[cfg(not(windows))]
    let builder = base;

    let w = builder.build()?;
    super::macos_window::configure_as_floating_panel(&w);
    super::macos_window::configure_for_all_spaces(&w);
    let app_handle = app.clone();
    let label = PET_CARD_LABEL.to_string();
    w.on_window_event(move |ev| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
            api.prevent_close();
            if let Some(win) = app_handle.get_webview_window(&label) {
                let _ = win.hide();
            }
        }
    });
    Ok(w)
}

/// Show the card. Called from the pet-click and bubble-click handlers
/// when there is a pending decision. If the window doesn't exist yet
/// the first call builds it.
///
/// `compact = true` opens the card in the user-facing idle / status
/// mode introduced by #365 (title + subtitle + last-checked + sources +
/// Collapse / Open Loop buttons). The card webview listens for
/// `loop:card-mode` and immediately swaps its `data-active-mode`
/// attribute; this is emitted BEFORE `show()` so the JS handler is in
/// place before the first paint. Subsequent `loop:decision` /
/// `loop:pending-list` events still flow into the same window, so a
/// pending decision landing after a compact open transitions the card
/// into the full decision layout without an extra rebuild.
pub fn show_card_window(app: &AppHandle) {
    show_card_window_with(app, false);
}

/// Compact-mode sibling of `show_card_window`. Same window, same
/// positioning, but opens in the #365 idle/status surface so the user
/// sees a quiet, plain-language answer to "what is Loomi doing?" rather
/// than the full decision card chrome.
pub fn show_card_compact_window(app: &AppHandle) {
    show_card_window_with(app, true);
}

fn show_card_window_with(app: &AppHandle, compact: bool) {
    super::aux_position::clear_card_manual_position();
    super::aux_position::reposition_card_to_pet(app);
    // Emit the mode hint BEFORE the first paint so the JS handler can
    // set `data-active-mode` on the card root synchronously. Without
    // this the card would briefly show the full-mode chrome before
    // swapping to compact, which (on slower machines) is a visible
    // flash. Same payload shape on every open — listeners that don't
    // care about the mode field ignore it.
    let _ = app.emit_to(
        PET_CARD_LABEL,
        "loop:card-mode",
        serde_json::json!({ "compact": compact }),
    );
    if let Some(w) = app.get_webview_window(PET_CARD_LABEL) {
        let _ = w.set_ignore_cursor_events(false);
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.set_always_on_top(true);
        let _ = w.set_visible_on_all_workspaces(true);
        // Re-apply the NSPanel conversion on every show so a
        // transient rebuild of the underlying NSWindow doesn't
        // quietly strip our non-activating-overlay behaviour.
        super::macos_window::configure_as_floating_panel(&w);
        super::macos_window::configure_for_all_spaces(&w);
        return;
    }
    if let Err(e) = build_card_window(app) {
        log::warn!("[loop-pet] show_card_window: build failed: {e}");
    }
    if let Some(w) = app.get_webview_window(PET_CARD_LABEL) {
        let _ = w.set_ignore_cursor_events(false);
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.set_always_on_top(true);
        let _ = w.set_visible_on_all_workspaces(true);
        // Re-apply the NSPanel conversion on every show so a
        // transient rebuild of the underlying NSWindow doesn't
        // quietly strip our non-activating-overlay behaviour.
        super::macos_window::configure_as_floating_panel(&w);
        super::macos_window::configure_for_all_spaces(&w);
    }
}

/// Hide the card without destroying it. State (last rendered decision)
/// is preserved in the DOM.
pub fn hide_card_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PET_CARD_LABEL) {
        let _ = w.hide();
    }
}
