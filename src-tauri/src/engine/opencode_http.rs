//! Supplemental OpenCode HTTP client — the one thing ACP doesn't cover.
//!
//! ACP has no runtime MCP/LSP status, so to power the ServerTools panel we run a
//! short-lived `opencode serve` for the *active* workspace only (started on
//! demand by `ServerManager`, idle-reaped) and read `/mcp` + `/lsp` over HTTP.
//! This is deliberately the sole remaining OpenCode HTTP surface.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub name: String,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStatus {
    pub id: String,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolsStatus {
    pub mcp: Vec<McpStatus>,
    pub lsp: Vec<LspStatus>,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("build reqwest client")
}

/// Fetch a URL and return its body as text, logging status + a body preview so
/// we can see exactly what opencode returned when a status panel comes up empty.
async fn get_text(url: &str) -> Result<String, String> {
    let resp = client().get(url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let preview: String = body.chars().take(400).collect();
    crate::logf!("tools", "GET {url} -> {status} body={preview}");
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    Ok(body)
}

/// Runtime MCP server status (`/mcp` → `{ name: { status, error? } }`).
pub async fn mcp_status(base: &str) -> Result<Vec<McpStatus>, String> {
    #[derive(Deserialize)]
    struct Entry {
        status: Option<String>,
        error: Option<String>,
    }
    let body = get_text(&format!("{base}/mcp")).await?;
    let data: HashMap<String, Entry> = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut out: Vec<McpStatus> = data
        .into_iter()
        .map(|(name, v)| McpStatus { name, status: v.status.unwrap_or_else(|| "unknown".into()), error: v.error })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Runtime LSP server status (`/lsp`).
pub async fn lsp_status(base: &str) -> Result<Vec<LspStatus>, String> {
    #[derive(Deserialize)]
    struct Entry {
        id: Option<String>,
        status: Option<String>,
        state: Option<String>,
    }
    let body = get_text(&format!("{base}/lsp")).await?;
    let data: Vec<Entry> = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(data
        .into_iter()
        .enumerate()
        .map(|(i, l)| LspStatus { id: l.id.unwrap_or_else(|| format!("lsp-{i}")), status: l.status.or(l.state) })
        .collect())
}

/// Connect (enable) an MCP server at runtime.
pub async fn mcp_connect(base: &str, name: &str) -> Result<(), String> {
    post(base, &format!("/mcp/{}/connect", urlencode(name))).await
}

/// Disconnect (disable) an MCP server at runtime.
pub async fn mcp_disconnect(base: &str, name: &str) -> Result<(), String> {
    post(base, &format!("/mcp/{}/disconnect", urlencode(name))).await
}

async fn post(base: &str, path: &str) -> Result<(), String> {
    let r = client()
        .post(format!("{base}{path}"))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if r.status().is_success() {
        Ok(())
    } else {
        Err(format!("HTTP {}", r.status()))
    }
}

/// Minimal percent-encoding for an MCP server name in a URL path segment.
fn urlencode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}
