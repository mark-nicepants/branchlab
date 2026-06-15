//! OpenCode config-file access for the Config & Internals panel.
//!
//! OpenCode reads a global config (`$XDG_CONFIG_HOME/opencode/opencode.json`,
//! default `~/.config/opencode`) and an optional per-project `opencode.json` in
//! the working directory. Both may use the `.jsonc` extension. We let the user
//! view/edit the raw file and restart the server to apply it.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ConfigFile {
    pub path: String,
    pub content: String,
    pub exists: bool,
}

/// Global opencode config directory.
pub fn global_dir() -> PathBuf {
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{}/.config", std::env::var("HOME").unwrap_or_default()));
    PathBuf::from(base).join("opencode")
}

/// Prefer an existing `opencode.jsonc`, then `opencode.json`; otherwise default
/// to `opencode.json` (marked non-existent).
fn resolve(dir: &Path) -> (PathBuf, bool) {
    for name in ["opencode.jsonc", "opencode.json"] {
        let p = dir.join(name);
        if p.exists() {
            return (p, true);
        }
    }
    (dir.join("opencode.json"), false)
}

pub fn read(dir: &Path) -> ConfigFile {
    let (path, exists) = resolve(dir);
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    ConfigFile { path: path.to_string_lossy().into_owned(), content, exists }
}

pub fn write(dir: &Path, content: &str) -> Result<String, String> {
    let (path, _) = resolve(dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
