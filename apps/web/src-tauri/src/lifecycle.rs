// Application lifecycle: the single, authoritative path for a *real* shutdown.
//
// Hide-to-tray paths intentionally do NOT touch this module. Only genuine quit
// flows (tray "Quit", Cmd+Q, explicit exit) funnel through here, so cleanup
// steps have exactly one place to live.

use crate::{js_scheduler, node, pet};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

/// Tracks the single shutdown cleanup so it runs exactly once and so the
/// `ExitRequested` handler can tell a "still cleaning" pass (block the exit)
/// from a "cleanup done" pass (let the exit through).
static CLEANUP_DONE: AtomicBool = AtomicBool::new(false);

/// Request the app to exit.
///
/// This does NOT perform cleanup directly — it just signals exit. The actual
/// shutdown work (stop scheduler, kill Node) runs once, in a background thread,
/// from the `RunEvent::ExitRequested` handler in `main.rs`. Keeping this cheap
/// and non-blocking means quit entry points (menu callbacks, tray clicks) never
/// freeze the UI thread.
pub fn request_exit(app: &AppHandle) {
    println!("📴 Exit requested");
    app.exit(0);
}

/// Whether shutdown cleanup has fully completed.
///
/// The `ExitRequested` handler blocks the exit (via `prevent_exit`) until this
/// returns true, so an in-flight cleanup can't be interrupted by a second exit
/// request; once cleanup is done the next exit pass is allowed through.
pub fn cleanup_done() -> bool {
    CLEANUP_DONE.load(Ordering::SeqCst)
}

/// Perform the one-time background-service shutdown: stop the JS scheduler and
/// tear down the Node.js sidecar process.
///
/// Idempotent: `cleanup_nodejs_process` is guarded by its own `CleanupFlagGuard`,
/// and `stop_js_scheduler` is wrapped so it also runs at most once across
/// concurrent callers. After the work finishes (or if it already ran), marks
/// cleanup as done so the pending exit can proceed.
pub fn run_cleanup() {
    // `SCHEDULER_STOPPED` ensures `stop_js_scheduler` runs exactly once even
    // under concurrent callers; `cleanup_nodejs_process` is idempotent on its own.
    static SCHEDULER_STOPPED: AtomicBool = AtomicBool::new(false);

    if SCHEDULER_STOPPED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        println!("📴 Shutting down background services...");

        // Close the pet webview *before* killing Node: the pet's
        // bundled HTML can issue `invoke()` calls on close, and we
        // don't want it racing a sidecar that's about to die. The pet
        // has no persistent state on the Tauri side (positions live
        // in its own localStorage), so a hard close is safe here.
        println!("📴 Closing Loomi pet window...");
        pet::close_pet_for_exit_if_open();

        println!("📴 Stopping scheduler...");
        js_scheduler::stop_js_scheduler();

        println!("📴 Cleaning up Node.js process...");
        node::cleanup_nodejs_process();

        println!("📴 Background service shutdown complete.");
    }

    // Mark done whether we just cleaned up or it already happened. Either way,
    // the pending exit is now free to proceed.
    CLEANUP_DONE.store(true, Ordering::SeqCst);
}
