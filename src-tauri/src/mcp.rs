//! `branchlab mcp-tasks` — a tiny read-only MCP server over the task board.
//!
//! Registered into the user's global opencode config at app startup (see
//! `register_in_opencode_config`), so every agent session gets board tools:
//! `branchlab_list_tasks` and `branchlab_get_task`. The server is a separate
//! short-lived process per engine; it reads `tasks.json`/`registry.json`
//! fresh on every call (the app is the only writer — reading the LWW files
//! directly keeps this process trivially consistent). Deliberately read-only:
//! a second writer would race the app's Mutex+persist model.
//!
//! Transport: MCP stdio — newline-delimited JSON-RPC 2.0.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::tasks::{ActivityEntry, Column, ColumnRole, Task};

/// Entry point for the `mcp-tasks` process mode (never returns Err to the
/// user — protocol errors go back as JSON-RPC errors).
pub fn run_stdio() {
    let data_dir = std::env::var("BL_DATA_DIR").map(PathBuf::from).ok();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(reply) = handle(&msg, data_dir.as_deref()) else { continue };
        let _ = writeln!(stdout, "{reply}");
        let _ = stdout.flush();
    }
}

fn handle(msg: &Value, data_dir: Option<&Path>) -> Option<Value> {
    let method = msg.get("method")?.as_str()?;
    let id = msg.get("id").cloned();
    // Notifications (no id) need no reply.
    id.as_ref()?;
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "branchlab-tasks", "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_defs() })),
        "tools/call" => call_tool(msg, data_dir),
        _ => Err((-32601, format!("method not found: {method}"))),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        }
    })
}

fn tool_defs() -> Value {
    json!([
        {
            "name": "list_tasks",
            "description": "The BranchLab task board this session may belong to: every open task with its #number, title, state, project, parent and blockers. Use when the user or a task prompt references a #number you don't know.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "get_task",
            "description": "Full detail for one BranchLab task by #number: description, state, estimate, parent, subtasks, blockers, and its activity feed (events + user comments).",
            "inputSchema": {
                "type": "object",
                "properties": { "number": { "type": "integer", "description": "The task number (the N in #N)" } },
                "required": ["number"],
                "additionalProperties": false
            }
        }
    ])
}

// ── Board reading (fresh from disk per call) ────────────────────────────────

#[derive(serde::Deserialize)]
struct BoardFile {
    #[serde(default)]
    columns: Vec<Column>,
    #[serde(default)]
    tasks: Vec<Task>,
    #[serde(default)]
    activity: Vec<ActivityEntry>,
}

fn load_board(data_dir: Option<&Path>) -> Result<BoardFile, (i64, String)> {
    let dir = data_dir.ok_or((-32603, "BL_DATA_DIR is not set".to_string()))?;
    let raw =
        std::fs::read_to_string(dir.join("tasks.json")).map_err(|e| (-32603, format!("cannot read the board: {e}")))?;
    serde_json::from_str(&raw).map_err(|e| (-32603, format!("cannot parse the board: {e}")))
}

/// Project id → name, best-effort from registry.json.
fn project_names(data_dir: Option<&Path>) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Some(dir) = data_dir else { return out };
    let Ok(raw) = std::fs::read_to_string(dir.join("registry.json")) else { return out };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else { return out };
    for p in v.get("projects").and_then(|p| p.as_array()).cloned().unwrap_or_default() {
        if let (Some(id), Some(name)) = (p.get("id").and_then(|s| s.as_str()), p.get("name").and_then(|s| s.as_str())) {
            out.insert(id.to_string(), name.to_string());
        }
    }
    out
}

fn state_of(board: &BoardFile, t: &Task) -> &'static str {
    match board.columns.iter().find(|c| c.id == t.column_id).map(|c| c.role) {
        Some(ColumnRole::Done) => "done",
        Some(ColumnRole::Review) => "in review",
        Some(ColumnRole::Active) if t.workspace_id.is_some() => "in progress",
        Some(ColumnRole::Active) => "queued",
        _ => "todo",
    }
}

fn number_of<'a>(board: &'a BoardFile, id: &str) -> Option<&'a Task> {
    board.tasks.iter().find(|t| t.id == id && t.deleted_at.is_none())
}

fn call_tool(msg: &Value, data_dir: Option<&Path>) -> Result<Value, (i64, String)> {
    let params = msg.get("params").cloned().unwrap_or_default();
    let name = params.get("name").and_then(|n| n.as_str()).unwrap_or_default();
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let board = load_board(data_dir)?;
    let names = project_names(data_dir);
    let text = match name {
        "list_tasks" => {
            let mut live: Vec<&Task> = board.tasks.iter().filter(|t| t.deleted_at.is_none()).collect();
            live.sort_by_key(|t| t.number);
            let mut out = String::from("BranchLab board:\n");
            for t in &live {
                out.push_str(&format!("#{} {} [{}]", t.number, t.title, state_of(&board, t)));
                if let Some(p) = t.project_id.as_ref().and_then(|p| names.get(p)) {
                    out.push_str(&format!(" ({p})"));
                }
                if let Some(parent) = t.parent_id.as_ref().and_then(|p| number_of(&board, p)) {
                    out.push_str(&format!(" subtask-of:#{}", parent.number));
                }
                let deps: Vec<String> = t
                    .depends_on
                    .iter()
                    .filter_map(|d| number_of(&board, d).map(|t| format!("#{}", t.number)))
                    .collect();
                if !deps.is_empty() {
                    out.push_str(&format!(" after:{}", deps.join(",")));
                }
                out.push('\n');
            }
            out
        }
        "get_task" => {
            let number = args.get("number").and_then(|n| n.as_u64()).ok_or((-32602, "number required".to_string()))?;
            let t = board
                .tasks
                .iter()
                .find(|t| t.number == number && t.deleted_at.is_none())
                .ok_or((-32602, format!("no task #{number}")))?;
            let mut out = format!("#{} {} [{}]\n", t.number, t.title, state_of(&board, t));
            if let Some(p) = t.project_id.as_ref().and_then(|p| names.get(p)) {
                out.push_str(&format!("Project: {p}\n"));
            }
            if let Some(e) = t.estimate {
                out.push_str(&format!("Estimate: {e}\n"));
            }
            if let Some(parent) = t.parent_id.as_ref().and_then(|p| number_of(&board, p)) {
                out.push_str(&format!("Subtask of: #{} {}\n", parent.number, parent.title));
            }
            let deps: Vec<String> = t
                .depends_on
                .iter()
                .filter_map(|d| number_of(&board, d).map(|t| format!("#{} {}", t.number, t.title)))
                .collect();
            if !deps.is_empty() {
                out.push_str(&format!("Blocked by: {}\n", deps.join("; ")));
            }
            if let Some(d) = &t.description {
                out.push_str(&format!("\n{d}\n"));
            }
            let mut kids: Vec<&Task> = board
                .tasks
                .iter()
                .filter(|c| c.deleted_at.is_none() && c.parent_id.as_deref() == Some(t.id.as_str()))
                .collect();
            kids.sort_by_key(|c| c.number);
            if !kids.is_empty() {
                out.push_str("\nSubtasks:\n");
                for c in kids {
                    out.push_str(&format!("- #{} {} [{}]\n", c.number, c.title, state_of(&board, c)));
                }
            }
            let feed: Vec<&ActivityEntry> = board.activity.iter().filter(|a| a.task_id == t.id).collect();
            if !feed.is_empty() {
                out.push_str("\nActivity (oldest first):\n");
                for a in feed.iter().rev().take(30).rev() {
                    match a.kind.as_str() {
                        "comment" | "command" => out.push_str(&format!("- {} commented: {}\n", a.actor, a.body)),
                        kind if a.body.is_empty() => out.push_str(&format!("- {kind} ({})\n", a.actor)),
                        kind => out.push_str(&format!("- {kind}: {} ({})\n", a.body, a.actor)),
                    }
                }
            }
            out
        }
        other => return Err((-32602, format!("unknown tool: {other}"))),
    };
    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

// ── Startup registration into the global opencode config ───────────────────

/// Idempotently register this binary as opencode's `branchlab` MCP server.
/// Skipped (with a log line) when the config isn't plain JSON we can safely
/// round-trip — a JSONC file with comments must not lose them to a rewrite.
pub fn register_in_opencode_config(data_dir: &Path) {
    let Ok(exe) = std::env::current_exe() else { return };
    let dir = crate::config::global_dir();
    let path = dir.join("opencode.json");
    let jsonc = dir.join("opencode.jsonc");
    let (path, raw) = if jsonc.exists() {
        (jsonc.clone(), std::fs::read_to_string(&jsonc).unwrap_or_default())
    } else {
        (path.clone(), std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into()))
    };
    let Ok(mut cfg) = serde_json::from_str::<Value>(&raw) else {
        crate::logf!("mcp", "opencode config at {} is not plain JSON — skipping MCP registration", path.display());
        return;
    };
    let desired = json!({
        "type": "local",
        "command": [exe.to_string_lossy(), "mcp-tasks"],
        "enabled": true,
        "environment": { "BL_DATA_DIR": data_dir.to_string_lossy() },
    });
    let mcp = cfg.as_object_mut().map(|o| o.entry("mcp").or_insert_with(|| json!({})));
    let Some(Value::Object(mcp)) = mcp else { return };
    if mcp.get("branchlab") == Some(&desired) {
        return; // already current
    }
    mcp.insert("branchlab".into(), desired);
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(pretty) = serde_json::to_string_pretty(&cfg) {
        if std::fs::write(&path, pretty).is_ok() {
            crate::logf!("mcp", "registered board MCP server in {}", path.display());
        }
    }
}
