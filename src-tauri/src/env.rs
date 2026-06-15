//! EnvProbe — detect external tools OpenScope depends on (opencode, git).
//!
//! OpenScope drives a user-installed `opencode` binary and uses `git` for
//! worktrees. Neither is bundled in the MVP, so on startup we probe PATH,
//! capture versions, and let the UI render an onboarding screen if something
//! is missing.

use serde::Serialize;
use std::process::Command;

/// State of one external dependency.
#[derive(Debug, Clone, Serialize)]
pub struct ToolStatus {
    /// Whether the tool was found on PATH.
    pub found: bool,
    /// Absolute path to the resolved binary, if found.
    pub path: Option<String>,
    /// Version string as reported by the tool, if obtainable.
    pub version: Option<String>,
}

impl ToolStatus {
    fn missing() -> Self {
        Self { found: false, path: None, version: None }
    }
}

/// Aggregate environment report returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct EnvReport {
    pub opencode: ToolStatus,
    pub git: ToolStatus,
}

/// Resolve a binary on PATH and ask it for its version.
///
/// `version_args` is the argument list that prints a version (e.g. `--version`).
/// `extract` pulls a clean version string out of the raw stdout, since tools
/// differ (git prints `git version 2.50.1`, opencode prints just `1.17.7`).
fn probe_tool(bin: &str, version_args: &[&str], extract: fn(&str) -> Option<String>) -> ToolStatus {
    let resolved = match which::which(bin) {
        Ok(p) => p,
        Err(_) => return ToolStatus::missing(),
    };

    let version = Command::new(&resolved)
        .args(version_args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout);
            extract(text.trim())
        });

    ToolStatus {
        found: true,
        path: Some(resolved.to_string_lossy().into_owned()),
        version,
    }
}

/// opencode prints just the bare version (e.g. `1.17.7`) to stdout.
fn extract_opencode_version(out: &str) -> Option<String> {
    out.lines().next().map(|l| l.trim().to_string()).filter(|s| !s.is_empty())
}

/// git prints `git version 2.50.1 (Apple Git-155)`; keep the numeric token.
fn extract_git_version(out: &str) -> Option<String> {
    out.split_whitespace().nth(2).map(|s| s.to_string())
}

/// Build a full environment report.
pub fn probe() -> EnvReport {
    EnvReport {
        opencode: probe_tool("opencode", &["--version"], extract_opencode_version),
        git: probe_tool("git", &["--version"], extract_git_version),
    }
}

/// Tauri command: report the state of external dependencies.
#[tauri::command]
pub fn probe_environment() -> EnvReport {
    probe()
}
