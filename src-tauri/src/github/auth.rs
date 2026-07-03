//! `gh` CLI integration, isolated per account.
//!
//! BranchLab delegates GitHub *authentication* to `gh` but does its data access
//! over the API (see `github::client`). Every account owns its own
//! `GH_CONFIG_DIR`, so multiple accounts stay signed in concurrently without the
//! global-state races that `gh auth switch` would cause. Only three `gh` call
//! sites remain: device login, logout, and token extraction.

use std::path::Path;
use std::process::Command;

/// Build a `gh` command scoped to one account's isolated config dir. Callers add
/// their own args. `host` scopes auth/token operations to the right host.
pub fn gh_command(config_dir: &Path, host: &str) -> Command {
    let mut cmd = Command::new("gh");
    cmd.env("GH_CONFIG_DIR", config_dir)
        .env("GH_HOST", host)
        .env("GH_PROMPT_DISABLED", "1")
        // Keep the credential prompt from ever blocking a backend child.
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    cmd
}

/// Extract the OAuth token for an account from its isolated `gh` config.
/// Returns `Err` if `gh` isn't installed or the account isn't authenticated.
pub fn fetch_token(config_dir: &Path, host: &str) -> Result<String, String> {
    let out = gh_command(config_dir, host)
        .args(["auth", "token", "--hostname", host])
        .output()
        .map_err(|e| format!("gh failed to run (is it installed?): {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if token.is_empty() {
        return Err("gh returned an empty token".into());
    }
    Ok(token)
}

/// Authenticate an isolated config dir from a token piped over stdin
/// (`gh auth login --with-token`). Deterministic — the GHE-friendly fallback to
/// the interactive device flow.
pub fn login_with_token(config_dir: &Path, host: &str, token: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = gh_command(config_dir, host)
        .args(["auth", "login", "--hostname", host, "--git-protocol", "https", "--with-token"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("gh failed to run (is it installed?): {e}"))?;
    child
        .stdin
        .take()
        .ok_or("could not open gh stdin")?
        .write_all(format!("{}\n", token.trim()).as_bytes())
        .map_err(|e| format!("could not send token to gh: {e}"))?;
    let out = child.wait_with_output().map_err(|e| format!("gh did not complete: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Sign an account out of its isolated config (best-effort; ignores errors).
pub fn logout(config_dir: &Path, host: &str) {
    let _ = gh_command(config_dir, host).args(["auth", "logout", "--hostname", host]).output();
}

/// Parse `gh version 2.86.0 (2024-…)` → `2.86.0`.
pub fn extract_gh_version(out: &str) -> Option<String> {
    // First line looks like "gh version 2.86.0 (2024-11-27)".
    out.lines().next().and_then(|l| l.split_whitespace().nth(2)).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gh_version() {
        assert_eq!(extract_gh_version("gh version 2.86.0 (2024-11-27)\nhttps://…"), Some("2.86.0".into()));
        assert_eq!(extract_gh_version(""), None);
    }
}
