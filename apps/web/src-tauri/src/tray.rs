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
    let show_loomi = MenuItem::with_id(app, "tray-show-loomi", "Show Loomi", true, None::<&str>)?;
    let hide_loomi = MenuItem::with_id(app, "tray-hide-loomi", "Hide Loomi", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit openloomi", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &show_loomi, &hide_loomi, &quit])?;

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
            "tray-show-loomi" => {
                crate::pet::show_pet_window(app);
                crate::pet::sync_dock_policy(app);
            }
            "tray-hide-loomi" => {
                crate::pet::hide_pet_window(app);
                crate::pet::sync_dock_policy(app);
            }
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
///
/// `pub` so the pet can ask us to do this from its own
/// `pet:open-dashboard` event without going through a second `#[command]`.
///
/// Also re-syncs the macOS Dock icon policy after the show, since
/// every caller that brings main back should restore the Dock too —
/// otherwise the icon can stay stuck in `Accessory` after the user
/// re-opens the window from the tray. The sync is deferred because
/// `is_visible()` lags one frame after `.show()` returns; this mirrors
/// the workaround used in the `pet:open-dashboard` handler in main.rs.
pub fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let app_for_deferred = app.clone();
    std::thread::spawn(move || {
        // Let the NSWindow settle so `is_visible()` no longer returns the
        // pre-`show()` value. Then bounce to the main thread before touching
        // AppKit — `sync_dock_policy` calls `setApplicationIconImage:`
        // which is only safe on the main thread, and calling it from a
        // background thread corrupts the objc selector table and later
        // crashes main-thread rendering (CALayer init SIGSEGV).
        std::thread::sleep(std::time::Duration::from_millis(80));
        let app_for_main = app_for_deferred.clone();
        let _ = app_for_deferred.run_on_main_thread(move || {
            crate::pet::sync_dock_policy(&app_for_main);
        });
    });
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
