// Shared positioning helpers for the pet's auxiliary windows (bubble + card).
//
// Both `loomi-bubble` and `loomi-card` are anchored ABOVE the pet,
// horizontally centered on it. The pet's `Moved` event invokes
// `reposition_bubble_to_pet` / `reposition_card_to_pet` so the auxiliary
// windows track the pet as the user drags it across the desktop.
//
// `startDragging()` in the pet's HTML uses the OS-native drag (via
// tao); Tauri 2.x's tao backend only fires `WindowEvent::Moved` on
// release, not continuously during the drag, so visual follow would
// look like a single jump at the end of the drag. To get smooth
// real-time following we also run a low-frequency poller (see
// `spawn_position_poller`) that re-asserts the aux windows' position
// at 20Hz — `set_position` is essentially a property write, so the
// per-tick cost is negligible.
//
// All positions are in *logical* pixels when read via `set_position` —
// Tauri accepts either physical or logical coordinates via the
// `Position` enum, and using logical keeps the math aligned with the
// `inner_size` values we declare on the windows. The pet's
// `outer_position()` returns physical pixels, so we convert via the
// pet's scale factor before adding offsets.

use std::time::Duration;

use tauri::{AppHandle, LogicalPosition, Manager, PhysicalPosition, WebviewWindow};

use super::{PET_AUX_GAP, PET_BUBBLE_LABEL, PET_CARD_LABEL, PET_LABEL, bubble, card};

const POLL_INTERVAL_MS: u64 = 50;

/// Read the pet's current outer position in physical pixels. Returns
/// `None` if the pet hasn't been built yet or the OS hasn't committed a
/// position (rare; happens during cold boot for one or two frames).
pub fn pet_position_physical(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let w = app.get_webview_window(PET_LABEL)?;
    w.outer_position().ok()
}

/// Pet's outer size in physical pixels. The 168×168 inner size is
/// logical; on a 2x display this is 336×336 physical.
fn pet_outer_size_physical(app: &AppHandle) -> Option<(f64, f64)> {
    let w = app.get_webview_window(PET_LABEL)?;
    let s = w.outer_size().ok()?;
    Some((s.width as f64, s.height as f64))
}

/// Compute the logical (left, top) for an aux window of the given
/// logical size anchored ABOVE the pet, horizontally centered on it.
///
/// `left = pet_center_x - aux_w / 2`  (the aux window's left edge)
/// `top  = pet_top - aux_h - PET_AUX_GAP`  (sits just above the pet)
fn position_above_pet(
    app: &AppHandle,
    pet: PhysicalPosition<i32>,
    aux_w_logical: f64,
    aux_h_logical: f64,
) -> LogicalPosition<f64> {
    let scale = pet_scale_factor(app).unwrap_or(1.0);
    let (pet_w_phys, _pet_h_phys) =
        pet_outer_size_physical(app).unwrap_or((168.0 * scale, 168.0 * scale));

    // Center horizontally on the pet. Pet's left in physical pixels is
    // `pet.x`; pet's right edge is `pet.x + pet_w_phys`; the aux window
    // is `aux_w_logical * scale` physical wide.
    let pet_center_x_phys = pet.x as f64 + pet_w_phys / 2.0;
    let aux_w_phys = aux_w_logical * scale;
    let left_logical = (pet_center_x_phys - aux_w_phys / 2.0) / scale;

    // Sit just above the pet. The aux window's bottom edge will be
    // PET_AUX_GAP above the pet's top.
    let top_logical = (pet.y as f64 - aux_h_logical * scale - PET_AUX_GAP * scale)
        / scale;

    LogicalPosition::new(left_logical, top_logical)
}

fn pet_scale_factor(app: &AppHandle) -> Option<f64> {
    app.get_webview_window(PET_LABEL)
        .and_then(|w| w.scale_factor().ok())
        .map(|s| s)
}

fn reposition(
    app: &AppHandle,
    label: &str,
    aux_w_logical: f64,
    aux_h_logical: f64,
    get_or_build: impl FnOnce(&AppHandle) -> tauri::Result<WebviewWindow>,
) {
    let Some(pet) = pet_position_physical(app) else {
        log::debug!("[loop-pet] reposition {label}: pet position not ready");
        return;
    };
    let target = position_above_pet(app, pet, aux_w_logical, aux_h_logical);
    log::debug!(
        "[loop-pet] reposition {label}: pet=({:.0},{:.0}) aux=({:.0}x{:.0}) → ({:.0},{:.0})",
        pet.x,
        pet.y,
        aux_w_logical,
        aux_h_logical,
        target.x,
        target.y,
    );
    let win = match app.get_webview_window(label) {
        Some(w) => w,
        None => match get_or_build(app) {
            Ok(w) => w,
            Err(e) => {
                log::warn!("[loop-pet] could not build aux window {label}: {e}");
                return;
            }
        },
    };
    if let Err(e) = win.set_position(target) {
        log::warn!("[loop-pet] set_position failed for {label}: {e}");
    }
}

/// Reposition the bubble so it stays anchored above the pet.
/// Called by the pet's `Moved` event and after `build_bubble_window`.
pub fn reposition_bubble_to_pet(app: &AppHandle) {
    reposition(
        app,
        PET_BUBBLE_LABEL,
        bubble::BUBBLE_W,
        bubble::BUBBLE_H,
        bubble::build_bubble_window,
    );
}

/// Reposition the card so it stays anchored above the pet.
pub fn reposition_card_to_pet(app: &AppHandle) {
    reposition(
        app,
        PET_CARD_LABEL,
        card::CARD_W,
        card::CARD_H,
        card::build_card_window,
    );
}

/// Spawn a background thread that continuously re-asserts the bubble +
/// card positions based on the pet's current position. Necessary because
/// Tauri's `WindowEvent::Moved` only fires on release of a native drag,
/// not during — without polling, the aux windows would visibly jump at
/// the end of a drag instead of following smoothly.
///
/// Cost: `set_position` is a property write on the webview window, so
/// 20Hz is fine. The poller exits cleanly on app shutdown (the OS
/// terminates the process; we don't bother with a stop signal because
/// the work is idempotent and the threads are owned by the runtime).
pub fn spawn_position_poller(app: AppHandle) {
    std::thread::Builder::new()
        .name("loomi-pet-aux-position-poller".into())
        .spawn(move || {
            let _ = crate::panic_guard::catch_unwind_str(
                "loomi-pet aux position poller",
                || {
                    loop {
                        reposition_bubble_to_pet(&app);
                        reposition_card_to_pet(&app);
                        std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
                    }
                },
            );
        })
        .expect("spawn loomi-pet aux position poller");
}
