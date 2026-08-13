// Copyright 2026 openloomi Team. All rights reserved.
//
// Use of this source code is governed by a license that can be
// found in the LICENSE file in the root of this source tree.

//! System permission detection and management.
//!
//! Screen-recording checks use CoreGraphics from the main app process so TCC
//! attributes access to this binary. Folder probes and settings deep-links are
//! helpers for the permissions UI.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[cfg(target_os = "macos")]
mod macos_accessibility {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(
            options: core_foundation::dictionary::CFDictionaryRef,
        ) -> bool;
    }

    pub fn is_trusted() -> bool {
        crate::panic_guard::catch_unwind_or("AXIsProcessTrusted", false, || unsafe {
            AXIsProcessTrusted()
        })
    }

    /// Prompts the user to grant Accessibility (registers app in the list).
    pub fn request() -> bool {
        if is_trusted() {
            return true;
        }
        crate::panic_guard::catch_unwind_or("AXIsProcessTrustedWithOptions", false, || {
            let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
            let value = CFBoolean::true_value();
            let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
            unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) }
        })
    }
}

#[cfg(target_os = "macos")]
mod macos_system_audio {
    use block2::RcBlock;
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use objc2::runtime::Bool;
    use std::ffi::c_void;
    use std::sync::mpsc;
    use std::sync::OnceLock;
    use std::time::Duration;

    type PreflightFn =
        unsafe extern "C" fn(core_foundation::string::CFStringRef, *const c_void) -> i32;
    type RequestFn =
        unsafe extern "C" fn(core_foundation::string::CFStringRef, *const c_void, *const c_void);

    const TCC_FRAMEWORK: &str = "/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC";
    const SERVICE: &str = "kTCCServiceAudioCapture";

    fn tcc_handle() -> Option<*mut c_void> {
        static HANDLE: OnceLock<usize> = OnceLock::new();
        let addr = *HANDLE.get_or_init(|| {
            let path = match std::ffi::CString::new(TCC_FRAMEWORK) {
                Ok(path) => path,
                Err(_) => return 0,
            };
            let handle = unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_NOW) };
            if handle.is_null() {
                0
            } else {
                handle as usize
            }
        });
        if addr == 0 {
            None
        } else {
            Some(addr as *mut c_void)
        }
    }

    fn load_symbol<T>(name: &str) -> Option<T> {
        let handle = tcc_handle()?;
        let symbol = match std::ffi::CString::new(name) {
            Ok(symbol) => symbol,
            Err(_) => return None,
        };
        let func = unsafe { libc::dlsym(handle, symbol.as_ptr()) };
        if func.is_null() {
            return None;
        }
        Some(unsafe { std::mem::transmute_copy(&func) })
    }

    fn preflight_fn() -> Option<PreflightFn> {
        static FN: OnceLock<Option<PreflightFn>> = OnceLock::new();
        *FN.get_or_init(|| load_symbol("TCCAccessPreflight"))
    }

    fn request_fn() -> Option<RequestFn> {
        static FN: OnceLock<Option<RequestFn>> = OnceLock::new();
        *FN.get_or_init(|| load_symbol("TCCAccessRequest"))
    }

    /// Returns true when macOS has granted system-audio-only recording (kTCCServiceAudioCapture).
    pub fn preflight() -> bool {
        crate::panic_guard::catch_unwind_or("macos_system_audio.preflight", false, || {
            let Some(preflight) = preflight_fn() else {
                return false;
            };
            let service = CFString::from_static_string(SERVICE);
            let result = unsafe { preflight(service.as_concrete_TypeRef(), std::ptr::null()) };
            // kTCCAccessPreflightAllowed == 0
            result == 0
        })
    }

    /// Shows the macOS system-audio consent dialog (System Settings → System Audio only).
    pub fn request() -> bool {
        if preflight() {
            return true;
        }

        crate::panic_guard::catch_unwind_or("macos_system_audio.request", false, || {
            let Some(request) = request_fn() else {
                return preflight();
            };

            let (tx, rx) = mpsc::channel();
            let block = RcBlock::new(move |granted: Bool| {
                let _ = tx.send(granted.as_bool());
            });

            let service = CFString::from_static_string(SERVICE);
            unsafe {
                request(
                    service.as_concrete_TypeRef(),
                    std::ptr::null(),
                    RcBlock::as_ptr(&block) as *const c_void,
                );
            }

            match rx.recv_timeout(Duration::from_secs(120)) {
                Ok(granted) => granted || preflight(),
                Err(_) => preflight(),
            }
        })
    }
}

#[cfg(target_os = "macos")]
mod macos_screen_capture {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub fn preflight() -> bool {
        crate::panic_guard::catch_unwind_or("CGPreflightScreenCaptureAccess", false, || unsafe {
            CGPreflightScreenCaptureAccess()
        })
    }

    /// Shows the macOS screen-recording consent dialog and registers this app
    /// in System Settings → Privacy → Screen Recording (screen recording & system audio).
    pub fn request() -> bool {
        crate::panic_guard::catch_unwind_or("CGRequestScreenCaptureAccess", false, || unsafe {
            CGRequestScreenCaptureAccess()
        })
    }
}

#[cfg(target_os = "macos")]
mod macos_microphone {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaType};
    use objc2_foundation::NSString;

    fn audio_media_type() -> Retained<AVMediaType> {
        // AVMediaTypeAudio == @"soun"
        NSString::from_str("soun")
    }

    /// Returns true when macOS TCC has granted microphone access to this app.
    pub fn preflight() -> bool {
        crate::panic_guard::catch_unwind_or("AVCaptureDevice.preflight", false, || unsafe {
            let status =
                AVCaptureDevice::authorizationStatusForMediaType(audio_media_type().as_ref());
            status == AVAuthorizationStatus::Authorized
        })
    }

    /// Triggers the system microphone consent dialog when status is not determined.
    pub fn request() -> bool {
        if preflight() {
            return true;
        }

        crate::panic_guard::catch_unwind_or("AVCaptureDevice.request", false, || unsafe {
            let media_type = audio_media_type();
            if AVCaptureDevice::authorizationStatusForMediaType(media_type.as_ref())
                != AVAuthorizationStatus::NotDetermined
            {
                return preflight();
            }

            let (tx, rx) = mpsc::channel();
            let block = RcBlock::new(move |granted: Bool| {
                let _ = tx.send(granted.as_bool());
            });
            AVCaptureDevice::requestAccessForMediaType_completionHandler(
                media_type.as_ref(),
                &block,
            );

            if let Ok(granted) = rx.recv_timeout(Duration::from_secs(120)) {
                return granted;
            }

            preflight()
        })
    }
}

#[cfg(target_os = "macos")]
mod macos_notifications {
    use tauri::AppHandle;
    use tauri_plugin_notification::NotificationExt;

    /// Probes notification access using UNUserNotificationCenter.
    /// Returns true if notification access has been granted.
    pub fn preflight(app: &AppHandle) -> bool {
        crate::panic_guard::catch_unwind_or("macos_notifications.preflight", false, || {
            let notification = app.notification();
            match notification.permission_state() {
                Ok(tauri_plugin_notification::PermissionState::Granted) => true,
                _ => false,
            }
        })
    }

    /// Request notification permission and return whether granted.
    pub fn request(app: &AppHandle) -> bool {
        crate::panic_guard::catch_unwind_or("macos_notifications.request", false, || {
            let notification = app.notification();
            // Check if already granted
            match notification.permission_state() {
                Ok(tauri_plugin_notification::PermissionState::Granted) => return true,
                _ => {}
            }
            // Request permission via system dialog
            match notification.request_permission() {
                Ok(state) => state == tauri_plugin_notification::PermissionState::Granted,
                Err(_) => false,
            }
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PermissionState {
    pub id: String,
    pub granted: bool,
}

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()))
}

/// Probe whether a directory is currently readable by this app's responsibility chain.
/// We use a child process so the access check happens in a fresh process attributed
/// back to the app, which better matches permissions seen by spawned tools.
/// Best-effort probe, not a formal TCC authorization API.
fn probe_directory(path: &PathBuf) -> bool {
    crate::panic_guard::catch_unwind_or("probe_directory", false, || {
        let output = Command::new("ls")
            .arg(path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output();
        match output {
            Ok(o) => o.status.success(),
            Err(_) => false,
        }
    })
}

/// Probe Full Disk Access by reading the system TCC database.
/// Uses a child process to test access as a spawned tool would see it.
fn probe_full_disk_access() -> bool {
    crate::panic_guard::catch_unwind_or("probe_full_disk_access", false, || {
        let output = Command::new("cat")
            .arg("/Library/Application Support/com.apple.TCC/TCC.db")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output();
        match output {
            Ok(o) => o.status.success(),
            Err(_) => false,
        }
    })
}

/// Probe screen recording from the main process (not osascript — wrong TCC identity).
#[cfg(target_os = "macos")]
fn probe_screen_recording() -> bool {
    macos_screen_capture::preflight()
}

#[cfg(not(target_os = "macos"))]
fn probe_screen_recording() -> bool {
    true
}

/// Probe system-audio-only recording (Core Audio tap / cpal loopback on macOS 14.2+).
#[cfg(target_os = "macos")]
fn probe_system_audio() -> bool {
    macos_system_audio::preflight()
}

#[cfg(not(target_os = "macos"))]
fn probe_system_audio() -> bool {
    true
}

/// Probe microphone from the main process.
#[cfg(target_os = "macos")]
fn probe_microphone() -> bool {
    macos_microphone::preflight()
}

#[cfg(not(target_os = "macos"))]
fn probe_microphone() -> bool {
    true
}

/// Probe notification access from the main process.
#[cfg(target_os = "macos")]
fn probe_notification(app: &tauri::AppHandle) -> bool {
    macos_notifications::preflight(app)
}

#[cfg(not(target_os = "macos"))]
fn probe_notification(_app: &tauri::AppHandle) -> bool {
    true
}

/// Probe accessibility from the main process (required for global capture shortcut).
#[cfg(target_os = "macos")]
fn probe_accessibility() -> bool {
    macos_accessibility::is_trusted()
}

#[cfg(not(target_os = "macos"))]
fn probe_accessibility() -> bool {
    true
}

/// Whether Accessibility is granted (always true outside macOS).
pub fn is_accessibility_granted() -> bool {
    probe_accessibility()
}

/// Check all core system permissions via probing.
/// Runs on a background thread to avoid blocking the UI.
#[tauri::command]
pub async fn check_system_permissions(
    app: tauri::AppHandle,
) -> Result<Vec<PermissionState>, String> {
    crate::panic_guard::catch_unwind_future_result("check_system_permissions", async {
        // Probe most permissions on a background thread
        let (tx, rx) = tokio::sync::oneshot::channel();
        let home = home_dir();
        tauri::async_runtime::spawn_blocking(move || {
            let result = crate::panic_guard::catch_unwind_str("check_system_permissions", || {
                vec![
                    PermissionState {
                        id: "macos:full-disk-access".to_string(),
                        granted: probe_full_disk_access(),
                    },
                    PermissionState {
                        id: "macos:downloads".to_string(),
                        granted: probe_directory(&home.join("Downloads")),
                    },
                    PermissionState {
                        id: "macos:documents".to_string(),
                        granted: probe_directory(&home.join("Documents")),
                    },
                    PermissionState {
                        id: "macos:desktop".to_string(),
                        granted: probe_directory(&home.join("Desktop")),
                    },
                    PermissionState {
                        id: "macos:screen-recording".to_string(),
                        granted: probe_screen_recording(),
                    },
                    PermissionState {
                        id: "macos:accessibility".to_string(),
                        granted: probe_accessibility(),
                    },
                    PermissionState {
                        id: "macos:microphone".to_string(),
                        granted: probe_microphone(),
                    },
                    PermissionState {
                        id: "macos:system-audio".to_string(),
                        granted: probe_system_audio(),
                    },
                ]
            });
            let _ = tx.send(result);
        });

        // Wait for blocking probes
        let mut other_permissions = rx
            .await
            .map_err(|e| format!("Permission check failed: {}", e))?
            .map_err(|e| format!("Permission check panicked: {}", e))?;

        // Probe notifications on the main thread (UNUserNotificationCenter must run on main thread)
        let (tx, rx) = tokio::sync::oneshot::channel();
        let app_clone = app.clone();
        app.run_on_main_thread(move || {
            let granted = probe_notification(&app_clone);
            let _ = tx.send(granted);
        })
        .map_err(|e| format!("Failed to probe notifications: {}", e))?;

        let notification_granted = rx
            .await
            .map_err(|e| format!("Notification probe failed: {}", e))?;

        other_permissions.push(PermissionState {
            id: "macos:notifications".to_string(),
            granted: notification_granted,
        });

        Ok(other_permissions)
    })
    .await
}

/// Request Accessibility via the system prompt (adds app to the Accessibility list).
#[tauri::command]
pub async fn request_accessibility_access() -> Result<bool, String> {
    crate::panic_guard::catch_unwind_future_result("request_accessibility_access", async {
        tauri::async_runtime::spawn_blocking(|| {
            crate::panic_guard::catch_unwind_str("request_accessibility_access", || {
                #[cfg(target_os = "macos")]
                {
                    macos_accessibility::request()
                }
                #[cfg(not(target_os = "macos"))]
                {
                    true
                }
            })
        })
        .await
        .map_err(|e| format!("request_accessibility_access join error: {}", e))
        .and_then(|inner| inner)
    })
    .await
}

/// Whether system-audio-only recording (kTCCServiceAudioCapture) is granted.
#[cfg(target_os = "macos")]
pub fn is_system_audio_granted() -> bool {
    macos_system_audio::preflight()
}

#[cfg(not(target_os = "macos"))]
pub fn is_system_audio_granted() -> bool {
    true
}

/// Ensure screen recording is granted before starting system audio capture.
///
/// Triggers the macOS consent dialog when needed. Returns an actionable error
/// when the user has not granted access.
#[cfg(target_os = "macos")]
pub fn ensure_screen_recording_access() -> Result<(), String> {
    if macos_screen_capture::preflight() {
        return Ok(());
    }

    log::info!("[Permissions] Requesting screen recording access for system audio");
    macos_screen_capture::request();

    if macos_screen_capture::preflight() {
        return Ok(());
    }

    Err(
        "Screen Recording permission is required for system audio. Enable this app in \
         System Settings → Privacy & Security → Screen Recording, then restart the app."
            .into(),
    )
}

#[cfg(not(target_os = "macos"))]
pub fn ensure_screen_recording_access() -> Result<(), String> {
    Ok(())
}

/// Request system-audio-only recording via the macOS consent dialog.
#[tauri::command]
pub async fn request_system_audio_access(app: tauri::AppHandle) -> Result<bool, String> {
    crate::panic_guard::catch_unwind_future_result("request_system_audio_access", async {
        #[cfg(target_os = "macos")]
        {
            run_macos_permission_prompt(app, "request_system_audio_access", || {
                macos_system_audio::request()
            })
            .await
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = app;
            Ok(true)
        }
    })
    .await
}

/// Request screen recording via the system consent dialog. Registers this app in
/// the Screen Recording list so the user only needs to click Allow.
#[tauri::command]
pub async fn request_screen_recording_access() -> Result<bool, String> {
    crate::panic_guard::catch_unwind_future_result("request_screen_recording_access", async {
        tauri::async_runtime::spawn_blocking(|| {
            crate::panic_guard::catch_unwind_str("request_screen_recording_access", || {
                #[cfg(target_os = "macos")]
                {
                    macos_screen_capture::request()
                }
                #[cfg(not(target_os = "macos"))]
                {
                    true
                }
            })
        })
        .await
        .map_err(|e| format!("request_screen_recording_access join error: {}", e))
        .and_then(|inner| inner)
    })
    .await
}

/// Run a macOS permission prompt on the main thread. UI dialogs must not be
/// triggered from Tauri's background command pool or the sheet may render blank.
#[cfg(target_os = "macos")]
async fn run_macos_permission_prompt<F>(
    app: tauri::AppHandle,
    context: &str,
    f: F,
) -> Result<bool, String>
where
    F: FnOnce() -> bool + Send + 'static,
{
    let context_label = context.to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = crate::panic_guard::catch_unwind_str(&context_label, f);
        let _ = tx.send(result);
    })
    .map_err(|e| format!("{context}: failed to dispatch to main thread: {e}"))?;

    rx.await
        .map_err(|_| format!("{context}: permission request was cancelled"))?
}

/// Request microphone access via the system prompt. Shows the native consent
/// dialog when needed; returns whether access is granted after the request.
#[tauri::command]
pub async fn request_microphone_access(app: tauri::AppHandle) -> Result<bool, String> {
    crate::panic_guard::catch_unwind_future_result("request_microphone_access", async {
        #[cfg(target_os = "macos")]
        {
            run_macos_permission_prompt(app, "request_microphone_access", || {
                macos_microphone::request()
            })
            .await
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = app;
            Ok(true)
        }
    })
    .await
}

/// Request notification access by triggering the system notification permission prompt.
/// On macOS, this uses tauri_plugin_notification API to request permission.
#[tauri::command]
pub async fn request_notification_access(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let app_for_closure = app.clone();
        run_macos_permission_prompt(app, "request_notification_access", move || {
            macos_notifications::request(&app_for_closure)
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(true)
    }
}

/// Trigger the macOS TCC dialog by accessing a protected folder from the main process.
/// Non-macOS platforms do not require this TCC flow.
#[tauri::command]
pub async fn request_folder_access(folder: String) -> Result<bool, String> {
    crate::panic_guard::catch_unwind_future_result("request_folder_access", async {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = folder;
            return Ok(true);
        }

        #[cfg(target_os = "macos")]
        tauri::async_runtime::spawn_blocking(move || {
            crate::panic_guard::catch_unwind_result("request_folder_access", || {
                let home = home_dir();
                let path = match folder.as_str() {
                    "Downloads" => home.join("Downloads"),
                    "Documents" => home.join("Documents"),
                    "Desktop" => home.join("Desktop"),
                    _ => return Err(format!("Unknown folder: {}", folder)),
                };

                match std::fs::read_dir(&path) {
                    Ok(_) => Ok(true),
                    Err(e) => {
                        log::warn!(
                            "request_folder_access({}) denied: {} (kind={:?})",
                            folder,
                            e,
                            e.kind()
                        );
                        Ok(false)
                    }
                }
            })
        })
        .await
        .map_err(|e| format!("request_folder_access join error: {}", e))?
    })
    .await
}

/// Open the macOS System Settings to a specific privacy pane.
#[tauri::command]
pub fn open_system_settings(pane: String) -> Result<(), String> {
    crate::panic_guard::catch_unwind_result("open_system_settings", || {
        #[cfg(target_os = "macos")]
        {
            let url = match pane.as_str() {
                "Privacy_AllFiles" => {
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
                }
                "Privacy_ScreenCapture" => {
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
                }
                "Privacy_Accessibility" => {
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
                }
                "Privacy_FilesAndFolders" => {
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
                }
                "Privacy_Microphone" => {
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
                }
                "Privacy_Notifications" => {
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_Notifications"
                }
                "Notifications" => "x-apple.systempreferences:com.apple.Notifications-Settings",
                _ => {
                    return Err(format!("Unknown settings pane: {}", pane));
                }
            };

            Command::new("open")
                .arg(url)
                .spawn()
                .map_err(|e| format!("Failed to open System Settings: {}", e))?;
        }

        #[cfg(not(target_os = "macos"))]
        {
            log::warn!(
                "open_system_settings is only supported on macOS (requested: {})",
                pane
            );
        }

        Ok(())
    })
}
