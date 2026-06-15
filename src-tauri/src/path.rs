//! PATH repair for GUI launches.
//!
//! Launched from a terminal (`tauri dev`), BranchLab inherits the shell's
//! `PATH` and finds tools like `opencode` fine. But a packaged `.app` launched
//! from Finder/Dock gets only a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:
//! /sbin`) — so `opencode` (installed in `~/.opencode/bin`, Homebrew, etc.) is
//! invisible while `/usr/bin/git` still resolves. That asymmetry is exactly the
//! "works in dev, missing in the release build" symptom.
//!
//! To make the packaged app behave like the terminal launch, we resolve the
//! user's login-shell `PATH` at startup and merge in the common install dirs,
//! then set it on the process. `which::which` (the env probe) and `Command`
//! (the opencode server spawn) both read this, so fixing it once covers both —
//! and the spawned server inherits it too, so it can find its own deps.

use std::collections::HashSet;
use std::path::PathBuf;

/// Resolve the login shell's `PATH` and merge it (plus common install dirs)
/// into this process's `PATH`. Best-effort: silently keeps the existing `PATH`
/// on any failure. Call once, as early as possible at startup.
pub fn fix_path() {
    let mut dirs: Vec<String> = Vec::new();

    // 1. Keep whatever we were launched with (terminal launches already win here).
    if let Ok(current) = std::env::var("PATH") {
        dirs.extend(current.split(':').map(str::to_string));
    }

    // 2. The user's interactive login shell PATH (sources .zprofile/.zshrc/etc).
    if let Some(shell_path) = login_shell_path() {
        dirs.extend(shell_path.split(':').map(str::to_string));
    }

    // 3. Common locations tool installers use, in case the shell didn't list
    //    them (e.g. a non-default shell, or PATH set by a GUI session manager).
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for sub in [".opencode/bin", ".local/bin", ".bun/bin"] {
            dirs.push(home.join(sub).to_string_lossy().into_owned());
        }
    }
    for p in ["/opt/homebrew/bin", "/usr/local/bin"] {
        dirs.push(p.to_string());
    }

    // Dedup while preserving first-seen order; drop empties.
    let mut seen = HashSet::new();
    let merged: Vec<String> = dirs.into_iter().filter(|d| !d.is_empty() && seen.insert(d.clone())).collect();

    if !merged.is_empty() {
        std::env::set_var("PATH", merged.join(":"));
    }
}

#[cfg(target_os = "windows")]
fn login_shell_path() -> Option<String> {
    // Windows GUI apps inherit the user/system PATH from the registry, so there
    // is no login-shell step to replicate.
    None
}

#[cfg(not(target_os = "windows"))]
fn login_shell_path() -> Option<String> {
    use std::process::Command;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // `-ilc` runs an interactive login shell so it sources the same startup
    // files a real terminal would (where installers add their bin dirs).
    let out = Command::new(&shell).args(["-ilc", "printf '%s' \"$PATH\""]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}
