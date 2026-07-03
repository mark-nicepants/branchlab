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

// Reasoning effort is configured per-model in the opencode config itself and
// applied by opencode when that model runs. opencode does NOT expose reasoning
// over ACP (see anomalyco/opencode#34551), so BranchLab never sets it at runtime
// or restarts for it — instead the Models settings page lets the user write it
// to the config explicitly (persisted; applied on the next session).

/// Whether we know how to write a reasoning option for `provider`.
pub fn reasoning_supported(provider: &str) -> bool {
    reasoning_value(provider, "high").is_some()
}

/// Map a provider + level to the opencode model-option key/value (the "prebuilt
/// configurations" for Anthropic / Gemini / Copilot / OpenAI). `default` clears
/// reasoning; an unsupported provider/level → None. Anthropic/Gemini use a
/// thinking-token budget; Copilot/OpenAI use a `reasoningEffort` string.
fn reasoning_value(provider: &str, level: &str) -> Option<(&'static str, Value)> {
    if level == "default" {
        return None;
    }
    match provider {
        "anthropic" | "anthropic-vertex" | "bedrock" => {
            let budget = match level {
                "low" => 4096,
                "medium" => 10000,
                "high" => 20000,
                "max" => 32000,
                _ => return None,
            };
            Some(("thinking", json!({ "type": "enabled", "budgetTokens": budget })))
        }
        "google" | "google-vertex" | "vertex" => {
            let budget = match level {
                "low" => 4096,
                "medium" => 8000,
                "high" => 16000,
                "max" => 24576,
                _ => return None,
            };
            Some(("thinkingConfig", json!({ "thinkingBudget": budget })))
        }
        // GitHub Copilot reasoning models take an OpenAI-style effort string, but
        // top out at "high" (no xhigh).
        "github-copilot" | "copilot" => {
            let effort = match level {
                "low" => "low",
                "medium" => "medium",
                "high" | "max" => "high",
                _ => return None,
            };
            Some(("reasoningEffort", Value::String(effort.into())))
        }
        "openai" | "openai-compatible" | "azure" => {
            let effort = match level {
                "low" => "low",
                "medium" => "medium",
                "high" => "high",
                "max" => "xhigh",
                _ => return None,
            };
            Some(("reasoningEffort", Value::String(effort.into())))
        }
        _ => None,
    }
}

/// Reverse of [`reasoning_value`]: read the currently-configured reasoning level
/// for a model from the config at `dir`, for prefilling the UI. Returns
/// `"default"` when none is set (or the value isn't one we recognize).
pub fn model_reasoning_level(dir: &Path, provider: &str, model: &str) -> String {
    let cf = read(dir);
    let root: Value = serde_json::from_str(&cf.content).unwrap_or_default();
    let opts = &root["provider"][provider]["models"][model]["options"];
    if let Some(budget) = opts["thinking"]["budgetTokens"].as_i64() {
        return match budget {
            4096 => "low",
            10000 => "medium",
            20000 => "high",
            32000 => "max",
            _ => "high",
        }
        .into();
    }
    if let Some(budget) = opts["thinkingConfig"]["thinkingBudget"].as_i64() {
        return match budget {
            4096 => "low",
            8000 => "medium",
            16000 => "high",
            24576 => "max",
            _ => "high",
        }
        .into();
    }
    if let Some(effort) = opts["reasoningEffort"].as_str() {
        return match effort {
            "xhigh" => "max",
            other => other,
        }
        .into();
    }
    "default".into()
}

/// Ensure `v[key]` is an object and return it.
fn child<'a>(v: &'a mut Value, key: &str) -> &'a mut Value {
    v.as_object_mut()
        .expect("json object")
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()))
}

/// Write a model's reasoning level as its base options in the opencode config at
/// `dir`, merging into the existing file (preserving other keys). `default`
/// clears the managed keys. Refuses a non-plain-JSON config so a hand-maintained
/// file is never corrupted.
pub fn set_model_reasoning(dir: &Path, provider: &str, model: &str, level: &str) -> Result<(), String> {
    let cf = read(dir);
    let mut root: Value = if cf.content.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&cf.content)
            .map_err(|e| format!("{} isn't plain JSON ({e}); edit reasoning there manually", cf.path))?
    };
    if !root.is_object() {
        return Err("opencode config root is not a JSON object".into());
    }
    let provider_obj = child(&mut root, "provider");
    let model_obj = child(child(child(provider_obj, provider), "models"), model);
    let options = child(model_obj, "options");
    if let Some(o) = options.as_object_mut() {
        // Replace only the keys we manage; leave the user's other options intact.
        o.remove("thinking");
        o.remove("reasoningEffort");
        o.remove("thinkingConfig");
        if let Some((k, val)) = reasoning_value(provider, level) {
            o.insert(k.to_string(), val);
        }
    }
    let out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    write(dir, &out).map(|_| ())
}

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
    fn writes_reasoning_per_provider_and_roundtrips_level() {
        let dir = std::env::temp_dir().join(format!("bl-cfg-reason-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("opencode.json"), r#"{"theme":"dark"}"#).unwrap();

        // Anthropic: thinking budget; "max" → 32000.
        set_model_reasoning(&dir, "anthropic", "claude-opus-4-8", "max").unwrap();
        let v: Value = serde_json::from_str(&read(&dir).content).unwrap();
        assert_eq!(v["theme"], "dark", "unrelated keys preserved");
        assert_eq!(
            v["provider"]["anthropic"]["models"]["claude-opus-4-8"]["options"]["thinking"]["budgetTokens"],
            32000
        );
        assert_eq!(model_reasoning_level(&dir, "anthropic", "claude-opus-4-8"), "max");

        // Gemini: thinkingConfig budget.
        set_model_reasoning(&dir, "google", "gemini-2.5-pro", "medium").unwrap();
        assert_eq!(model_reasoning_level(&dir, "google", "gemini-2.5-pro"), "medium");

        // Copilot: reasoningEffort; "max" clamps to "high".
        set_model_reasoning(&dir, "github-copilot", "gpt-5", "max").unwrap();
        let v: Value = serde_json::from_str(&read(&dir).content).unwrap();
        assert_eq!(v["provider"]["github-copilot"]["models"]["gpt-5"]["options"]["reasoningEffort"], "high");
        assert_eq!(model_reasoning_level(&dir, "github-copilot", "gpt-5"), "high");

        // "default" clears it.
        set_model_reasoning(&dir, "anthropic", "claude-opus-4-8", "default").unwrap();
        assert_eq!(model_reasoning_level(&dir, "anthropic", "claude-opus-4-8"), "default");

        assert!(reasoning_supported("anthropic"));
        assert!(reasoning_supported("github-copilot"));
        assert!(!reasoning_supported("opencode"));
        let _ = std::fs::remove_dir_all(&dir);
    }

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
