//! Minimal append-to-file debug logger for the Rust backend.
//!
//! The chat/engine/supervisor paths run off-screen (background threads, async
//! tasks) where a panic or an ACP quirk is otherwise invisible. This writes a
//! timestamped line to a single logfile in the app-data dir (and mirrors it to
//! stderr so `npm run tauri dev` still shows it), which the user can tail while
//! reproducing a bug. The file is truncated on each launch so it always reflects
//! the current session and stays small.
//!
//! Use the [`logf!`] macro: `logf!("acp", "update {label}")`.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

struct LogState {
    file: File,
    path: PathBuf,
}

static LOG: OnceLock<Mutex<Option<LogState>>> = OnceLock::new();

fn cell() -> &'static Mutex<Option<LogState>> {
    LOG.get_or_init(|| Mutex::new(None))
}

/// Point the logger at `path`, truncating any prior contents. Call once at
/// startup. If the file can't be opened, logging silently degrades to stderr.
pub fn init(path: PathBuf) {
    let file = OpenOptions::new().create(true).write(true).truncate(true).open(&path);
    match file {
        Ok(file) => {
            *cell().lock().unwrap() = Some(LogState { file, path: path.clone() });
            log("logx", &format!("log initialized at {}", path.display()));
        }
        Err(e) => eprintln!("logx: could not open {}: {e}", path.display()),
    }
}

/// The active logfile path, if logging was initialized.
pub fn path() -> Option<PathBuf> {
    cell().lock().unwrap().as_ref().map(|s| s.path.clone())
}

/// Append one line: `HH:MM:SS.mmm [area] message`. Mirrored to stderr.
pub fn log(area: &str, msg: &str) {
    let line = format!("{} [{}] {}\n", timestamp(), area, msg);
    eprint!("{line}");
    if let Some(state) = cell().lock().unwrap().as_mut() {
        let _ = state.file.write_all(line.as_bytes());
        let _ = state.file.flush();
    }
}

/// UTC time-of-day `HH:MM:SS.mmm` — enough to correlate events while tailing,
/// without pulling in a calendar/date dependency.
fn timestamp() -> String {
    let dur = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs();
    let ms = dur.subsec_millis();
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    format!("{h:02}:{m:02}:{s:02}.{ms:03}")
}

/// `logf!("area", "fmt {x}", ...)` → formats and appends one log line.
#[macro_export]
macro_rules! logf {
    ($area:expr, $($arg:tt)*) => {
        $crate::logx::log($area, &format!($($arg)*))
    };
}
