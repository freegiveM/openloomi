// Copyright 2026 openloomi Team. All rights reserved.
//
// Use of this source code is governed by a license that can be
// found in the LICENSE file in the root of this source tree.

//! Integration tests for `sidecar_liveness` (#516). Exercises the real
//! background thread that produces the `~/.openloomi/sidecar.alive`
//! heartbeat file, not just the in-process helpers. Each test redirects
//! `$HOME` to a fresh tempdir so the user's real `~/.openloomi` is
//! never touched.
//!
//! A process-wide `HEARTBEAT_TEST_LOCK` mutex serialises the tests so a
//! stray background thread from a previous test cannot clobber the
//! next test's expectations. The unit tests in `lib.rs::tests` only
//! invoke the in-process helpers and don't touch the thread, so they
//! don't need to compete for the lock.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use openloomi_lib::sidecar_liveness as sl;

/// Process-wide serialisation so two integration tests don't race on
/// the static `HEARTBEAT_HANDLE`. Held for the duration of every test
/// below; cheap because we never run more than one concurrently.
static HEARTBEAT_TEST_LOCK: Mutex<()> = Mutex::new(());

struct HomeGuard {
    /// Previous value of `$HOME`, restored on drop.
    prev: Option<String>,
}

impl HomeGuard {
    fn install(dir: &PathBuf) -> Self {
        let prev = env::var("HOME").ok();
        env::set_var("HOME", dir);
        Self { prev }
    }
}

impl Drop for HomeGuard {
    fn drop(&mut self) {
        match &self.prev {
            Some(v) => env::set_var("HOME", v),
            None => env::remove_var("HOME"),
        }
    }
}

/// Make a fresh tempdir for `sidecar_liveness::stamp_path()` to resolve
/// to. Returns the path + a `HomeGuard` whose `Drop` restores `$HOME`.
fn fresh_home() -> (PathBuf, HomeGuard) {
    let dir = env::temp_dir().join(format!(
        "openloomi-sidecar-test-{}-{}",
        std::process::id(),
        Instant::now().elapsed().as_nanos(),
    ));
    fs::create_dir_all(&dir).expect("mkdir tempdir");
    let guard = HomeGuard::install(&dir);
    (dir, guard)
}

/// Poll `predicate()` every 25 ms up to `budget` total. Returns the
/// final value of the predicate so the caller can assert on `true`.
/// Splitting "is present?" from "did it appear?" keeps the test honest:
/// we want to know the file showed up *after* start_heartbeat, not
/// that some pre-existing file happened to match.
fn wait_for(budget: Duration, mut predicate: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if predicate() {
            return true;
        }
        thread::sleep(Duration::from_millis(25));
    }
    predicate()
}

#[test]
fn heartbeat_writes_stamp_and_clears_on_stop() {
    let _lock = HEARTBEAT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (home, _home_guard) = fresh_home();

    // 1. Pre-flight: nothing exists yet.
    let stamp = home.join(".openloomi").join("sidecar.alive");
    assert!(
        !stamp.exists(),
        "stamp should not exist before start_heartbeat, got {}",
        stamp.display()
    );

    // 2. Start the heartbeat thread.
    let expected_id = sl::boot_id();
    sl::start_heartbeat();

    // 3. Within HEARTBEAT_INTERVAL_SECS + 1 s of slack the file MUST
    //    be written and contain the boot id. If this assertion fails
    //    the production behaviour is broken end-to-end, not just the
    //    unit test helpers — #516's supervising loop is exactly this
    //    signal.
    let stamp_for_read = stamp.clone();
    let wrote = wait_for(Duration::from_millis(7_000), || {
        stamp_for_read.exists()
    });
    assert!(
        wrote,
        "stamp file {} never appeared within 7 s of start_heartbeat",
        stamp.display()
    );

    let actual = fs::read_to_string(&stamp).expect("read stamp");
    assert_eq!(
        actual.trim(),
        expected_id,
        "stamp contents must match boot_id()"
    );

    // 4. Stop the heartbeat. The thread exits, then `stop_heartbeat`
    //    deletes the stamp as part of its cleanup.
    sl::stop_heartbeat();

    let cleared = wait_for(Duration::from_millis(2_000), || !stamp.exists());
    assert!(
        cleared,
        "stamp file {} must be gone within 2 s of stop_heartbeat",
        stamp.display()
    );

    // 5. Cleanup: ensure the tempdir is dropped.
    drop(_home_guard);
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn write_stamp_creates_directory_and_writes_content_atomically() {
    let _lock = HEARTBEAT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (home, _home_guard) = fresh_home();

    let stamp_dir = home.join(".openloomi");
    assert!(
        !stamp_dir.exists(),
        "no .openloomi should exist before write_stamp"
    );

    sl::write_stamp();

    let stamp_path = stamp_dir.join("sidecar.alive");
    assert!(
        stamp_path.exists(),
        "stamp file must be created by write_stamp"
    );
    assert_eq!(
        fs::read_to_string(&stamp_path).unwrap().trim(),
        sl::boot_id(),
        "stamp contents match boot_id()"
    );

    // Re-write shouldn't accumulate junk or leave tmp files behind.
    sl::write_stamp();
    let tmp = stamp_dir.join("sidecar.alive.tmp");
    assert!(
        !tmp.exists(),
        "tmp file {} should be cleaned up after rename",
        tmp.display()
    );

    sl::clear_stamp();
    assert!(!stamp_path.exists(), "clear_stamp must remove the file");

    drop(_home_guard);
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn stop_heartbeat_is_idempotent() {
    let _lock = HEARTBEAT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (home, _home_guard) = fresh_home();

    // Multiple stop calls without a matching start should not panic
    // or block — the function is called from panic-hook paths that
    // may already have torn down the thread.
    sl::stop_heartbeat();
    sl::stop_heartbeat();
    sl::stop_heartbeat();

    let stamp = home.join(".openloomi").join("sidecar.alive");
    assert!(!stamp.exists());

    drop(_home_guard);
    let _ = fs::remove_dir_all(&home);
}
