// macOS Dock-icon policy for the pet.
//
// Goal: the Dock icon mirrors "is the *main* app in the foreground or
// is only the *pet* visible?". When neither window is showing, we fall
// back to `Regular` so the app can be re-launched via the Dock without
// users having to dig through `/Applications`.
//
// This avoids the trap of `LSUIElement=true` (always hide Dock) —
// users still need a way back to the main window from the Dock.
//
// `sync_dock_policy` is best-effort and swallows errors. A Tauri
// `set_activation_policy` failure shouldn't bring the app down.

use tauri::{ActivationPolicy, AppHandle, Manager};

use super::PET_LABEL;

pub fn sync_dock_policy(app: &AppHandle) {
    let main_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let pet_visible = app
        .get_webview_window(PET_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);

    let target = if main_visible {
        ActivationPolicy::Regular
    } else if pet_visible {
        ActivationPolicy::Accessory
    } else {
        ActivationPolicy::Regular
    };

    // `ActivationPolicy` is not `Copy`, so we snapshot the comparison
    // *before* moving `target` into `set_activation_policy`. We need
    // the flag in two places: the policy setter (which consumes it)
    // and the dock-icon branch below (which decides whether to also
    // re-apply the icon).
    let is_regular = matches!(target, ActivationPolicy::Regular);

    if let Err(e) = app.set_activation_policy(target) {
        log::warn!("[loomi-pet] set_activation_policy failed: {e}");
    }

    // When the policy lands on Regular, the Dock needs an icon. The OS
    // normally reads it from the .app bundle's Info.plist, but in dev
    // mode the binary isn't bundled, so the Dock shows the generic
    // exec icon. Apply the configured `bundle.icon` programmatically
    // via `[NSApp setApplicationIconImage:]` so dev matches prod.
    if is_regular {
        apply_default_icon_to_dock(app);
    }
}

/// Programmatically set the Dock icon to the app's configured window
/// icon. Idempotent and panic-safe — a Cocoa failure here would be
/// cosmetic, never fatal.
#[cfg(target_os = "macos")]
fn apply_default_icon_to_dock(app: &AppHandle) {
    use objc2::{class, msg_send, runtime::AnyObject};
    use objc2_foundation::NSData;

    let Some(icon) = app.default_window_icon() else {
        log::warn!("[loomi-pet] no default window icon configured; Dock will show exec icon");
        return;
    };
    // Tauri 2.x's `Image` only exposes raw RGBA + dimensions — there's
    // no built-in `to_png`. Encode with the `image` crate (already a
    // dependency for cross-platform reasons) so NSImage can decode it
    // via `initWithData:`.
    let Some(png_bytes) = encode_rgba_as_png(icon.rgba(), icon.width(), icon.height()) else {
        return;
    };

    // The ObjC calls below are unsafe in two ways: raw pointers crossing
    // the FFI boundary, and `setApplicationIconImage:` overriding the
    // bundle-provided icon. A panic during the calls would leave us in
    // a half-applied state, so we wrap in catch_unwind and silently
    // fall back to the OS default (the user just sees the exec icon).
    let _ = std::panic::catch_unwind(|| unsafe {
        let data = NSData::with_bytes(&png_bytes);
        let image: *mut AnyObject = msg_send![class!(NSImage), alloc];
        let image: *mut AnyObject = msg_send![image, initWithData: &*data];
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, setApplicationIconImage: image];
    });
}

/// Encode raw RGBA pixels as a PNG byte stream. Returns `None` if the
/// dimensions or pixel buffer are inconsistent, or if the encoder
/// rejects the data — both are unrecoverable for an icon, so we log
/// and let the caller fall back to the OS default.
fn encode_rgba_as_png(rgba: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    use image::{ImageEncoder, codecs::png::PngEncoder};
    let expected = (width as usize).checked_mul(height as usize)?.checked_mul(4)?;
    if rgba.len() != expected {
        log::warn!(
            "[loomi-pet] icon RGBA buffer mismatch: got {} bytes for {}x{}, expected {}",
            rgba.len(),
            width,
            height,
            expected
        );
        return None;
    }
    let mut out = Vec::new();
    let encoder = PngEncoder::new(&mut out);
    if encoder.write_image(rgba, width, height, image::ExtendedColorType::Rgba8).is_err() {
        log::warn!("[loomi-pet] PNG encoding failed for Dock icon");
        return None;
    }
    Some(out)
}

#[cfg(not(target_os = "macos"))]
fn apply_default_icon_to_dock(_app: &AppHandle) {}
