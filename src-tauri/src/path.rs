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
//! then set it on the process. The env probe's PATH lookup and `Command`
//! (the opencode server spawn) both read this, so fixing it once covers both —
//! and the spawned server inherits it too, so it can find its own deps.

use std::collections::HashSet;
use std::path::PathBuf;

/// Merge the launch `PATH`, the login shell's `PATH` (cached from a previous
/// launch), and common install dirs into this process's `PATH`. Best-effort:
/// silently keeps the existing `PATH` on any failure. Call once, as early as
/// possible at startup.
///
/// Resolving the login-shell PATH live means running an interactive zsh
/// (sourcing .zshrc, nvm, compinit, …) — routinely 0.5–2s, all of it spent
/// before the window can appear. So the slow resolve runs on a background
/// thread and only writes a cache file for the NEXT launch; `set_var` happens
/// exactly once, here, while the process is still single-threaded (late
/// `setenv` races concurrent `getenv` on macOS).
// ponytail: the first-ever launch misses exotic .zshrc-only dirs until the
// next launch; the common-dirs fallback below covers standard installs.
pub fn fix_path() {
    let mut dirs: Vec<String> = Vec::new();

    // 1. Keep whatever we were launched with (terminal launches already win here).
    if let Ok(current) = std::env::var("PATH") {
        dirs.extend(current.split(':').map(str::to_string));
    }

    // 2. The login-shell PATH cached by a previous launch.
    if let Some(cached) = cache_file().and_then(|f| std::fs::read_to_string(f).ok()) {
        dirs.extend(cached.trim().split(':').map(str::to_string));
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

    // 4. Refresh the cache off-thread so the next launch starts with the real
    //    login-shell PATH without paying for the shell.
    std::thread::spawn(|| {
        if let (Some(cache), Some(path)) = (cache_file(), login_shell_path()) {
            if let Some(parent) = cache.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&cache, path);
        }
    });
}

/// Where the resolved login-shell PATH is cached between launches. Lives in
/// the app-data dir, but computed without Tauri because `fix_path` must run
/// before the builder starts.
fn cache_file() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    Some(home.join("Library/Application Support/dev.branchlab.desktop/path-cache"))
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
