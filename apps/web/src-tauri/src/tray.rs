// System tray for openloomi.
//
// When the window is hidden to tray (see `close_behavior`), the tray icon is
// the user's way back in: left-click (or dock icon on macOS) restores the
// window; the context menu offers an explicit "Quit" that performs a real exit.
//
// Why `menu_on_left_click(false)`: on Windows/Linux a left click should restore
// the window (not pop the menu), matching the convention users expect from
// tray apps. macOS users restore via the Dock; the tray provides the menu.

use crate::lifecycle;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// Build and register the system tray icon and its menu.
pub fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "Show openloomi", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit openloomi", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("openloomi")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => show_main_window(app),
            "tray-quit" => lifecycle::request_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left single-click on the tray icon restores the window.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    // Only once the tray is actually live do we allow hide-to-tray; otherwise
    // `close_behavior` falls back to a real exit so users are never stranded.
    crate::close_behavior::mark_tray_available();

    Ok(())
}

/// Bring the main window back to the foreground.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Handle macOS `applicationShouldHandleReopen` (e.g. clicking the Dock icon
/// while the window is hidden to tray). Brings the main window back to front.
#[cfg(target_os = "macos")]
pub fn handle_reopen(app: &tauri::AppHandle, has_visible_windows: bool) {
    // If some window is already visible, let macOS do its default activation.
    if has_visible_windows {
        return;
    }
    show_main_window(app);
}
