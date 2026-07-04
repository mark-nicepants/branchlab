//! OpenCode config-file access for the Config & Internals panel.
//!
//! OpenCode reads a global config (`$XDG_CONFIG_HOME/opencode/opencode.json`,
//! default `~/.config/opencode`) and an optional per-project `opencode.json` in
//! the working directory. Both may use the `.jsonc` extension. We let the user
//! view/edit the raw file and restart the server to apply it.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

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

// Reasoning effort ("thinking level") is NOT configured here. opencode exposes
// it over ACP as a dynamic `effort` config option (category `thought_level`)
// that appears once a variant-capable model is selected — BranchLab sets it at
// runtime via `session/set_config_option`, so nothing is written to the config
// file for it. (The old per-model config-file mechanism predates opencode's ACP
// support for this and was removed.)

/// Read the global default model (top-level `model` key) from the opencode
/// config at `dir`, if set. opencode uses this to default new sessions.
pub fn get_default_model(dir: &Path) -> Option<String> {
    let cf = read(dir);
    if cf.content.trim().is_empty() {
        return None;
    }
    let root: Value = serde_json::from_str(&cf.content).ok()?;
    root.get("model").and_then(|m| m.as_str()).map(str::to_string)
}

/// Set (or clear, when `model` is `None`) the global default model — the
/// top-level `model` key in the opencode config at `dir` — merging into the
/// existing file and preserving other keys. Refuses a non-plain-JSON config so a
/// hand-maintained JSONC file is never corrupted.
pub fn set_default_model(dir: &Path, model: Option<&str>) -> Result<(), String> {
    let cf = read(dir);
    let mut root: Value = if cf.content.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&cf.content)
            .map_err(|e| format!("{} isn't plain JSON ({e}); set the default model there manually", cf.path))?
    };
    let obj = root.as_object_mut().ok_or("opencode config root is not a JSON object")?;
    match model {
        Some(m) if !m.is_empty() => {
            obj.insert("model".to_string(), Value::String(m.to_string()));
        }
        _ => {
            obj.remove("model");
        }
    }
    let out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    write(dir, &out).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_and_clears_default_model_preserving_other_keys() {
        let dir = std::env::temp_dir().join(format!("bl-cfg-model-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("opencode.json"), r#"{"theme":"dark"}"#).unwrap();

        assert_eq!(get_default_model(&dir), None);
        set_default_model(&dir, Some("anthropic/claude-opus-4-8")).unwrap();
        assert_eq!(get_default_model(&dir).as_deref(), Some("anthropic/claude-opus-4-8"));
        let v: Value = serde_json::from_str(&read(&dir).content).unwrap();
        assert_eq!(v["theme"], "dark", "unrelated keys preserved");

        set_default_model(&dir, None).unwrap();
        assert_eq!(get_default_model(&dir), None);
        let v: Value = serde_json::from_str(&read(&dir).content).unwrap();
        assert_eq!(v["theme"], "dark");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_non_json_config() {
        let dir = std::env::temp_dir().join(format!("bl-cfg-jsonc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("opencode.json"), "{ // a comment\n \"x\": 1 }").unwrap();
        assert!(set_default_model(&dir, Some("anthropic/claude-opus-4-8")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
