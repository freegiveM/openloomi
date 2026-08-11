//! Tauri-side supervisor liveness signal — backs issue #516.
//!
//! The Tauri desktop app is the *supervisor* of OpenLoomi's Next.js
//! sidecar. When Tauri exits cleanly we already tear the child down
//! (see `node::cleanup_nodejs_process` + the `process_group(0)` setup
//! which lets us `kill(-pgid, SIGTERM)`). But when the supervising
//! process disappears via a path that bypasses the usual exit
//! (rm -rf .app, kernel OOM kill, power loss, …) the child can survive
//! — and the Loop cron rows in `scheduled_jobs` are unrelated to who's
//! running the process, so they keep firing against the user's own
//! Claude subscription. The reported incident: ~84M tokens across 102
//! orphaned ticks in 14.5 h after uninstall (#516).
//!
//! This module is the supervisor side of the `parent-watch.ts` gate
//! that the Loop tick handler now enforces on the Node side. While the
//! supervisor is alive we rewrite a small file at `~/.openloomi/sidecar.alive`
//! every `HEARTBEAT_INTERVAL_SECS` with a unique-per-boot identifier
//! (the boot id). The Node child reads the file each tick and refuses
//! to fire if the file is missing, stale, or contains a different
//! boot id than the one the process was launched with
//! (`process.env.OPENLOOMI_BOOT_ID`).
//!
//! Lifecycle:
//!
//!   - `boot_id()` lazily mints the boot id; first call wins.
//!     `start_nextjs_server` injects the same string as `OPENLOOMI_BOOT_ID`
//!     into the spawned Node child env so the round-trip is consistent.
//!   - `start_heartbeat()` spawns the background thread that rewrites
//!     the stamp while the supervisor is alive. Called once after
//!     Next.js reports "running".
//!   - `stop_heartbeat()` signals the thread to exit and deletes the
//!     stamp. Called from `cleanup_nodejs_process` (and the panic-hook
//!     tear-down paths) so a clean shutdown leaves no orphan stamp.
//!
//! Crashes that bypass `cleanup_nodejs_process` (SIGKILL Tauri's own
//! process, rm -rf the .app while running) leave the stamp frozen at
//! its last mtime. The Node child treats stamps older than
//! `parent-watch.ts::PARENT_CHECK.staleAfterMs` (60 s) as orphans, so
//! within at most a minute of Tauri dying, Loop self-disables.
// Copyright 2026 openloomi Team. All rights reserved.

use crate::panic_guard::catch_unwind_str;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

/// How often we rewrite the stamp while the supervisor is alive.
/// 5 s is well below the 60 s `staleAfterMs` the Node child checks
/// against, with comfortable margin for a single missed wakeup under
/// load.
pub const HEARTBEAT_INTERVAL_SECS: u64 = 5;

/// File name under `~/.openloomi/`. NOT under `loop/` so its absence
/// does not collide with the loop module's own files.
pub const STAMP_FILENAME: &str = "sidecar.alive";

/// Env var name we set on the spawned Node child. Loop's `parent-watch`
/// reads this to know which boot id to expect on the stamp file.
pub const BOOT_ID_ENV: &str = "OPENLOOMI_BOOT_ID";

static BOOT_ID: OnceLock<String> = OnceLock::new();
static HEARTBEAT_STOP: AtomicBool = AtomicBool::new(false);
static HEARTBEAT_HANDLE: Mutex<Option<thread::JoinHandle<()>>> = Mutex::new(None);

/// Resolve the boot id lazily. First call mints a new id and stores it
/// in `BOOT_ID`; subsequent calls return the same value — including the
/// spawned Node child, which reads it from the inherited environment.
///
/// The id is `openloomi-boot-{pid}-{nanos_since_epoch}`. `pid`
/// distinguishes two supervisors running side-by-side; `nanos` is enough
/// randomness for the boot boundary (Tauri restarts always cycle pid
/// first, so uniqueness is guaranteed). Loop's `parent-watch.ts` does
/// strict equality, so collisions between boots are equivalent to "new
/// boot, old env" — exactly the boundary this check is designed to
/// catch.
pub fn boot_id() -> String {
    BOOT_ID
        .get_or_init(|| {
            let pid = std::process::id();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            format!("openloomi-boot-{}-{}", pid, nanos)
        })
        .clone()
}

/// Resolve `~/.openloomi/sidecar.alive`. Created lazily so test runs
/// in a sandbox can override via the `OPENLOOMI_HOME` env. Falls back
/// to a `$USERPROFILE` or `std::env::temp_dir()` path when neither
/// is set, which keeps the function total on every platform.
pub fn stamp_path() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string());
    PathBuf::from(home)
        .join(".openloomi")
        .join(STAMP_FILENAME)
}

/// Atomically write the boot id to the stamp file. Uses tmp + rename
/// so a tick read sees either the prior or new id but never a
/// half-written file. Best-effort — failures are logged by callers
/// and never panic, since this runs in a background thread.
pub fn write_stamp() {
    let path = stamp_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("⚠️  sidecar liveness: create_dir_all failed: {}", e);
            return;
        }
    }
    let id = boot_id();
    let tmp = {
        let mut p = path.as_os_str().to_owned();
        p.push(".tmp");
        PathBuf::from(p)
    };
    match std::fs::write(&tmp, &id) {
        Ok(_) => {
            if let Err(e) = std::fs::rename(&tmp, &path) {
                // Rename failed (e.g. cross-device on weird filesystems).
                // Fall back to a direct write so the file still gets a
                // current mtime — a one-tick window of stale-but-present
                // is preferable to a missing file.
                if let Err(e2) = std::fs::write(&path, &id) {
                    eprintln!(
                        "⚠️  sidecar liveness: rename and direct write both failed: {} / {}",
                        e, e2
                    );
                }
            }
        }
        Err(e) => {
            eprintln!("⚠️  sidecar liveness: tmp write failed: {}", e);
        }
    }
}

/// Remove the stamp file. Best-effort; we don't care if the file
/// wasn't there — it just needs to be gone after a clean shutdown.
pub fn clear_stamp() {
    if let Err(e) = std::fs::remove_file(stamp_path()) {
        // NotFound is the expected case (file never written or already
        // cleared). Anything else is worth a debug line.
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("⚠️  sidecar liveness: remove_file failed: {}", e);
        }
    }
}

/// Spawn the heartbeat background thread. Idempotent for repeated
/// callers — a prior running thread is joined before the new one starts
/// so the stamp is always held by exactly one thread.
pub fn start_heartbeat() {
    if let Some(handle) = HEARTBEAT_HANDLE.lock().unwrap().take() {
        HEARTBEAT_STOP.store(true, Ordering::SeqCst);
        let _ = handle.join();
        HEARTBEAT_STOP.store(false, Ordering::SeqCst);
    }
    let handle = match thread::Builder::new()
        .name("openloomi-sidecar-heartbeat".to_string())
        .spawn(move || {
            if let Err(e) = catch_unwind_str("sidecar heartbeat", || {
                // Stamp immediately so a tick firing in the same second
                // as startup already sees a fresh stamp (the watcher's
                // first run after server "running" can be that fast).
                write_stamp();
                loop {
                    if HEARTBEAT_STOP.load(Ordering::SeqCst) {
                        break;
                    }
                    thread::sleep(Duration::from_secs(HEARTBEAT_INTERVAL_SECS));
                    if HEARTBEAT_STOP.load(Ordering::SeqCst) {
                        break;
                    }
                    write_stamp();
                }
                clear_stamp();
            }) {
                eprintln!("⚠️  sidecar heartbeat stopped unexpectedly: {}", e);
            }
        }) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("⚠️  sidecar heartbeat spawn failed: {}", e);
            return;
        }
    };
    *HEARTBEAT_HANDLE.lock().unwrap() = Some(handle);
}

/// Stop the heartbeat background thread and remove the stamp.
/// Designed to be called from any teardown path (cleanup_nodejs_process,
/// panic hook, emergency exit). Idempotent.
pub fn stop_heartbeat() {
    HEARTBEAT_STOP.store(true, Ordering::SeqCst);
    if let Some(handle) = HEARTBEAT_HANDLE.lock().unwrap().take() {
        let _ = handle.join();
    }
    clear_stamp();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_id_is_stable_across_calls() {
        let a = boot_id();
        let b = boot_id();
        assert_eq!(a, b, "boot_id must memoize");
        assert!(a.starts_with("openloomi-boot-"));
    }

    #[test]
    fn stamp_path_ends_with_filename() {
        let p = stamp_path();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some(STAMP_FILENAME));
    }
}
