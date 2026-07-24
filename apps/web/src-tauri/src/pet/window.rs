// Pet window lifecycle: create, show, hide, exit-cleanup, and the
// `CloseRequested` -> `hide()` interception so the traffic-light / × button
// acts as "put away" rather than "destroy the widget".

use std::sync::{Mutex, OnceLock};

use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use super::PET_LABEL;

const PET_W: f64 = 168.0;
const PET_H: f64 = 168.0;
const PET_SCREEN_MARGIN_LOGICAL: f64 = 4.0;

#[derive(Clone, Copy, Debug, PartialEq)]
struct PhysicalBounds {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

fn bounds_from_monitor_work_area(monitor: &tauri::Monitor) -> PhysicalBounds {
    let work_area = monitor.work_area();
    PhysicalBounds {
        left: work_area.position.x as f64,
        top: work_area.position.y as f64,
        right: work_area.position.x as f64 + work_area.size.width as f64,
        bottom: work_area.position.y as f64 + work_area.size.height as f64,
    }
}

fn push_unique_bounds(bounds: &mut Vec<PhysicalBounds>, candidate: PhysicalBounds) {
    if !bounds.iter().any(|existing| *existing == candidate) {
        bounds.push(candidate);
    }
}

fn pet_candidate_bounds(window: &WebviewWindow) -> tauri::Result<Vec<PhysicalBounds>> {
    let mut bounds = Vec::new();

    if let Some(monitor) = window.current_monitor()? {
        push_unique_bounds(&mut bounds, bounds_from_monitor_work_area(&monitor));
    }
    if let Some(monitor) = window.primary_monitor()? {
        push_unique_bounds(&mut bounds, bounds_from_monitor_work_area(&monitor));
    }
    for monitor in window.available_monitors()? {
        push_unique_bounds(&mut bounds, bounds_from_monitor_work_area(&monitor));
    }

    Ok(bounds)
}

fn overlap_area(
    pos: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    bounds: PhysicalBounds,
) -> f64 {
    let left = pos.x as f64;
    let top = pos.y as f64;
    let right = left + size.width as f64;
    let bottom = top + size.height as f64;

    let overlap_w = right.min(bounds.right) - left.max(bounds.left);
    let overlap_h = bottom.min(bounds.bottom) - top.max(bounds.top);
    if overlap_w <= 0.0 || overlap_h <= 0.0 {
        0.0
    } else {
        overlap_w * overlap_h
    }
}

fn target_bounds_for_pet(
    pos: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    bounds: &[PhysicalBounds],
) -> Option<PhysicalBounds> {
    let mut best = None;
    let mut best_area = 0.0;

    for candidate in bounds {
        let area = overlap_area(pos, size, *candidate);
        if area > best_area {
            best = Some(*candidate);
            best_area = area;
        }
    }

    best.or_else(|| bounds.first().copied())
}

fn clamp_axis(start: f64, len: f64, min: f64, max: f64, margin: f64) -> f64 {
    let min_start = min + margin;
    let max_start = max - margin - len;
    if max_start >= min_start {
        start.clamp(min_start, max_start)
    } else {
        min + ((max - min) - len) / 2.0
    }
}

fn clamp_pet_position(
    pos: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    bounds: &[PhysicalBounds],
    margin: f64,
) -> Option<PhysicalPosition<i32>> {
    let target = target_bounds_for_pet(pos, size, bounds)?;
    let left = clamp_axis(
        pos.x as f64,
        size.width as f64,
        target.left,
        target.right,
        margin,
    );
    let top = clamp_axis(
        pos.y as f64,
        size.height as f64,
        target.top,
        target.bottom,
        margin,
    );
    Some(PhysicalPosition::new(
        left.round() as i32,
        top.round() as i32,
    ))
}

fn persist_pet_position(app: &AppHandle, reason: &str) {
    if let Err(error) = app.save_window_state(StateFlags::POSITION) {
        log::warn!("[loop-pet] failed to persist clamped position after {reason}: {error}");
    }
}

fn ensure_pet_in_visible_work_area(app: &AppHandle, reason: &str) {
    let Some(window) = app.get_webview_window(PET_LABEL) else {
        return;
    };
    if let Err(error) = clamp_pet_window_to_visible_work_area(app, &window, reason) {
        log::warn!("[loop-pet] failed to clamp pet position after {reason}: {error}");
    }
}

fn clamp_pet_window_to_visible_work_area(
    app: &AppHandle,
    window: &WebviewWindow,
    reason: &str,
) -> tauri::Result<()> {
    let pos = window.outer_position()?;
    let size = window.outer_size()?;
    if size.width == 0 || size.height == 0 {
        return Ok(());
    }

    let bounds = pet_candidate_bounds(window)?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let margin = PET_SCREEN_MARGIN_LOGICAL * scale;
    let Some(target) = clamp_pet_position(pos, size, &bounds, margin) else {
        return Ok(());
    };

    if target != pos {
        log::info!(
            "[loop-pet] clamping pet position after {reason}: ({},{}) -> ({},{})",
            pos.x,
            pos.y,
            target.x,
            target.y
        );
        window.set_position(target)?;
        persist_pet_position(app, reason);
    }

    Ok(())
}

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
    let builder =
        WebviewWindowBuilder::new(app, PET_LABEL, WebviewUrl::App("loomi-widget.html".into()))
            .title("Loomi")
            .inner_size(PET_W, PET_H)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .shadow(false)
            .visible(true)
            .focused(false)
            // Right-click into a borderless transparent window is silently
            // dropped by default — see issue #314. `accept_first_mouse(true)`
            // routes the very first interaction (including a right-click that
            // lands before any left-click) straight to the webview; `focusable`
            // makes the underlying NSWindow return `true` from
            // `canBecomeKeyWindow` so right-mouse events flow through to
            // WKWebView the same way they do in a standalone browser.
            .accept_first_mouse(true)
            .focusable(true)
            .drag_and_drop(false);

    #[cfg(not(windows))]
    let builder =
        WebviewWindowBuilder::new(app, PET_LABEL, WebviewUrl::App("loomi-widget.html".into()))
            .title("Loomi")
            .inner_size(PET_W, PET_H)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .shadow(false)
            .visible(true)
            .focused(false)
            .accept_first_mouse(true)
            .focusable(true);

    let window = builder.build()?;
    // Pet: keep the NSPanel class swap — the pet is a non-activating
    // overlay and doesn't host text-input, so the focusable-ivar
    // trade-off described in `configure_as_floating_panel_with`
    // doesn't apply.
    super::macos_window::configure_as_floating_panel_with(&window, true);
    super::macos_window::configure_for_all_spaces(&window);
    // Defensively re-apply the canonical inner size. The Pet window
    // label is shared between this build path and the
    // `tauri-plugin-window-state` persistence file
    // (`~/Library/Application Support/com.openloomi.app/.window-state.json`),
    // and an upgrade can leave the persisted size out of sync with the
    // current widget sprite (issue #341 — upgrade restored
    // `loomi-pet=84x84`, clipping the fox). The position side of the
    // saved state is still honoured so the user's drag position is
    // remembered; only the size is normalised back to PET_W × PET_H.
    // `set_size` on a `resizable(false)` window is a no-op when the
    // value already matches, so the steady-state cost is one equality
    // check.
    let _ = window.set_size(LogicalSize::new(PET_W, PET_H));
    ensure_pet_in_visible_work_area(app, "build");
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
        let _ = w.set_visible_on_all_workspaces(true);
        // Re-apply the NSPanel conversion on every show: if the OS
        // ever rebuilds the underlying NSWindow (rare, but happens
        // after certain screen-recording permission dialogs) the
        // class swap would otherwise be lost. Re-running the helper
        // is cheap and idempotent.
        super::macos_window::configure_as_floating_panel_with(&w, true);
        super::macos_window::configure_for_all_spaces(&w);
        ensure_pet_in_visible_work_area(app, "show");
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
    w.on_window_event(move |ev| match ev {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide_pet_window(&app_handle);
        }
        // Drag-to-reposition lands here on the pet window because the
        // HTML calls `startDragging()` directly (no `draggable=true` on
        // the titlebar). The aux windows (bubble + card) are anchored
        // above the pet, so re-emit a position update so they follow
        // along. Logging at `info` so the user can see in stdout whether
        // the handler is firing at all — if drag-stop is the symptom,
        // the absence of these lines tells us Tauri's tao backend
        // isn't dispatching `Moved` for the native drag and we need to
        // attach a position poller instead.
        tauri::WindowEvent::Moved(pos) => {
            log::info!(
                "[loop-pet] Moved → ({},{}) — repositioning aux windows",
                pos.x,
                pos.y
            );
            ensure_pet_in_visible_work_area(&app_handle, "move");
            on_pet_moved_reposition_aux(&app_handle);
        }
        _ => {}
    });
}

/// Reposition the bubble and card windows so they stay anchored above
/// the pet. Idempotent and safe to call on every `Moved` event (Tauri
/// emits these throughout the drag, so we want the work to be cheap —
/// `set_position` is a no-op when the new value matches the cached
/// one).
pub fn on_pet_moved_reposition_aux(app: &AppHandle) {
    super::aux_position::reposition_bubble_to_pet(app);
    super::aux_position::reposition_card_to_pet(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(left: f64, top: f64, right: f64, bottom: f64) -> PhysicalBounds {
        PhysicalBounds {
            left,
            top,
            right,
            bottom,
        }
    }

    fn pos(x: i32, y: i32) -> PhysicalPosition<i32> {
        PhysicalPosition::new(x, y)
    }

    fn size(width: u32, height: u32) -> PhysicalSize<u32> {
        PhysicalSize::new(width, height)
    }

    /// Canonical Pet dimensions must match the widget sprite. This is
    /// the regression guard for issue #341: when an upgrade left an
    /// invalid persisted size in `.window-state.json`, the Pet was
    /// restored at the wrong inner size and the fox got clipped. The
    /// builder is the single source of truth, and `build_pet_window`
    /// re-applies these constants defensively after the window is
    /// constructed — both sides must agree.
    #[test]
    fn pet_canonical_dimensions_match_widget_sprite() {
        assert_eq!(PET_W, 168.0, "Pet width must match the widget sprite");
        assert_eq!(PET_H, 168.0, "Pet height must match the widget sprite");
        assert_eq!(PET_W, PET_H, "Pet window must be square");
        assert!(PET_W > 0.0, "Pet width must be positive");
        assert!(PET_H > 0.0, "Pet height must be positive");
        // Reject the half-size clip that #341 reported. If a future
        // refactor accidentally halves either dimension the sprite
        // will be clipped exactly like the upgrade did, so we assert
        // the value is strictly larger than the regression threshold.
        assert!(
            PET_W > 84.0,
            "Pet width must exceed the #341 half-size clip (84px)"
        );
    }

    #[test]
    fn pet_position_inside_work_area_is_unchanged() {
        let display = [bounds(0.0, 0.0, 1920.0, 1040.0)];

        assert_eq!(
            clamp_pet_position(pos(120, 160), size(168, 168), &display, 4.0),
            Some(pos(120, 160))
        );
    }

    #[test]
    fn pet_position_is_clamped_inside_each_edge() {
        let display = [bounds(0.0, 0.0, 1920.0, 1040.0)];
        let pet_size = size(168, 168);

        assert_eq!(
            clamp_pet_position(pos(-300, 100), pet_size, &display, 4.0),
            Some(pos(4, 100))
        );
        assert_eq!(
            clamp_pet_position(pos(2100, 100), pet_size, &display, 4.0),
            Some(pos(1748, 100))
        );
        assert_eq!(
            clamp_pet_position(pos(100, -80), pet_size, &display, 4.0),
            Some(pos(100, 4))
        );
        assert_eq!(
            clamp_pet_position(pos(100, 1100), pet_size, &display, 4.0),
            Some(pos(100, 868))
        );
    }

    #[test]
    fn pet_position_uses_intersecting_secondary_monitor_with_negative_origin() {
        let displays = [
            bounds(0.0, 0.0, 1920.0, 1040.0),
            bounds(-1280.0, 0.0, 0.0, 984.0),
        ];

        assert_eq!(
            clamp_pet_position(pos(-1400, 120), size(168, 168), &displays, 4.0),
            Some(pos(-1276, 120))
        );
    }

    #[test]
    fn pet_position_without_any_monitor_bounds_is_unchanged_by_caller() {
        assert_eq!(
            clamp_pet_position(pos(4000, 300), size(168, 168), &[], 4.0),
            None
        );
    }

    #[test]
    fn oversized_pet_is_centered_when_full_containment_is_impossible() {
        let tiny_display = [bounds(0.0, 0.0, 100.0, 100.0)];

        assert_eq!(
            clamp_pet_position(pos(40, 40), size(168, 168), &tiny_display, 4.0),
            Some(pos(-34, -34))
        );
    }
}
