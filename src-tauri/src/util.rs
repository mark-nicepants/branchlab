//! Tiny helpers shared across subsystems.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

/// Poisoning-recovering mutex lock.
///
/// `Mutex::lock().unwrap()` panics forever once any thread panicked while
/// holding the lock — a single bug in one subsystem would cascade into every
/// other lock site app-wide. Every mutex in this crate guards plain state
/// whose worst case after a mid-update panic is a stale or partial value,
/// which is always preferable to wedging the whole app — so we deliberately
/// enter the poisoned mutex and keep going.
pub trait LockExt<T> {
    fn lock_safe(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_safe(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Spawn a long-lived background task with a sibling monitor that logs when
/// (and how) it dies. These loops are expected to run for the app's whole
/// lifetime, so BOTH outcomes are reported loudly: a clean return means the
/// loop broke unexpectedly, and an error means it panicked (the runtime
/// catches the panic — without the monitor the task would just vanish).
pub fn spawn_watched<F>(area: &'static str, name: &'static str, fut: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let task = tauri::async_runtime::spawn(fut);
    tauri::async_runtime::spawn(async move {
        match task.await {
            Ok(()) => crate::logf!(area, "background task '{name}' exited unexpectedly"),
            Err(e) => crate::logf!(area, "background task '{name}' DIED: {e}"),
        }
    });
}

/// Current time in epoch milliseconds.
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A fresh sortable id (monotonic ULID).
pub fn new_id() -> String {
    ulid::Ulid::generate().to_string()
}

/// Tolerant "JSON somewhere in the reply" parse: first `{` .. last `}`, then
/// serde (models love fences and prose around the object).
pub fn json_blob<T: serde::de::DeserializeOwned>(raw: &str) -> Option<T> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    serde_json::from_str(&raw[start..=end]).ok()
}

/// Write a state file atomically: write to `<file>.tmp` in the same directory,
/// then rename over the target. The rename is atomic on the same filesystem,
/// so a crash mid-write can never leave a truncated/half-written file behind.
pub fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.tmp"));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

/// Load a JSON state file leniently: a missing file is a normal first run
/// (default); a present-but-unparseable file is quarantined to `<file>.bad`
/// (never overwritten in place — the user's data may still be recoverable by
/// hand) and logged loudly, then the default is used.
pub fn load_json_or_quarantine<T: serde::de::DeserializeOwned + Default>(path: &Path, area: &str) -> T {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return T::default(), // missing file = normal first run
    };
    match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            match quarantine(path) {
                Some(bad) => crate::logf!(
                    area,
                    "CORRUPT state file {}: {e} — moved aside to {} and starting from defaults",
                    path.display(),
                    bad.display()
                ),
                None => crate::logf!(
                    area,
                    "CORRUPT state file {}: {e} — could not move it aside; starting from defaults",
                    path.display()
                ),
            }
            T::default()
        }
    }
}

/// Move a corrupt file aside as `<file>.bad` (numeric suffix when a prior
/// quarantine already exists, so evidence is never clobbered).
fn quarantine(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let mut bad = path.with_file_name(format!("{name}.bad"));
    let mut n = 1;
    while bad.exists() && n < 100 {
        n += 1;
        bad = path.with_file_name(format!("{name}.bad{n}"));
    }
    std::fs::rename(path, &bad).ok()?;
    Some(bad)
}
