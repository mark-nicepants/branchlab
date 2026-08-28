//! The board write-bridge: a loopback TCP listener that lets the `mcp-tasks`
//! process (and only local processes holding the per-launch token) write to
//! the board THROUGH the running app — comments and new tasks go through the
//! one TaskStore instead of racing tasks.json with a second writer.
//!
//! Protocol: one JSON line per connection, one JSON line back.
//!   {"token":"…","op":"comment","number":7,"body":"…"}
//!   {"token":"…","op":"create","title":"…","description":"…","parentNumber":4}
//! Discovery: `mcp-bridge.json` in the app data dir ({port, token}), rewritten
//! on every app launch (the token rotates).

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

pub fn start(app: AppHandle, data_dir: &Path) {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            crate::logf!("bridge", "cannot bind the board bridge: {e}");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let token = format!("{}{}", ulid::Ulid::generate(), ulid::Ulid::generate());
    let file = data_dir.join("mcp-bridge.json");
    if let Ok(body) = serde_json::to_string(&json!({ "port": port, "token": token })) {
        let _ = std::fs::write(&file, body);
    }
    crate::logf!("bridge", "board bridge on 127.0.0.1:{port}");

    let token = Arc::new(token);
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(conn) = conn else { continue };
            let app = app.clone();
            let token = Arc::clone(&token);
            // One line in, one line out — cheap enough to handle inline, but a
            // thread per connection keeps a stalled client from blocking others.
            std::thread::spawn(move || handle(conn, &app, &token));
        }
    });
}

fn handle(mut conn: TcpStream, app: &AppHandle, token: &str) {
    let _ = conn.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let mut line = String::new();
    if BufReader::new(conn.try_clone().expect("clone tcp")).read_line(&mut line).is_err() {
        return;
    }
    let reply = match serde_json::from_str::<Value>(&line) {
        Ok(req) if req.get("token").and_then(|t| t.as_str()) == Some(token) => dispatch(&req, app),
        Ok(_) => Err("bad token".to_string()),
        Err(e) => Err(format!("bad request: {e}")),
    };
    let body = match reply {
        Ok(v) => json!({ "ok": true, "result": v }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    let _ = writeln!(conn, "{body}");
}

fn dispatch(req: &Value, app: &AppHandle) -> Result<Value, String> {
    let tasks = app.state::<crate::tasks::TaskStore>();
    let by_number = |n: u64| tasks.find_by_number(n).ok_or_else(|| format!("no task #{n}"));
    let result = match req.get("op").and_then(|o| o.as_str()).unwrap_or_default() {
        "comment" => {
            let number = req.get("number").and_then(|n| n.as_u64()).ok_or("number required")?;
            let body = req.get("body").and_then(|b| b.as_str()).ok_or("body required")?;
            let task = by_number(number)?;
            tasks.add_comment(&task.id, "comment", "agent", body)?;
            json!({ "commented": format!("#{number}") })
        }
        "create" => {
            let title = req.get("title").and_then(|t| t.as_str()).ok_or("title required")?;
            let description = req.get("description").and_then(|d| d.as_str()).map(String::from);
            let parent_id = match req.get("parentNumber").and_then(|n| n.as_u64()) {
                Some(n) => Some(by_number(n)?.id),
                None => None,
            };
            let task = tasks.create_task_from_agent(title.to_string(), description, parent_id)?;
            json!({ "created": format!("#{}", task.number), "number": task.number })
        }
        other => return Err(format!("unknown op: {other}")),
    };
    let _ = app.emit("tasks:changed", tasks.snapshot());
    Ok(result)
}

/// Client side (used by the `mcp-tasks` process): one request line → the
/// bridge's `result` value, or a user-facing error string.
pub fn call(data_dir: &Path, mut req: Value) -> Result<Value, String> {
    let raw = std::fs::read_to_string(data_dir.join("mcp-bridge.json"))
        .map_err(|_| "BranchLab isn't running — board writes need the app open".to_string())?;
    let cfg: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let port = cfg.get("port").and_then(|p| p.as_u64()).ok_or("bad bridge file")?;
    let token = cfg.get("token").and_then(|t| t.as_str()).ok_or("bad bridge file")?;
    req["token"] = json!(token);
    let mut conn = TcpStream::connect(("127.0.0.1", port as u16))
        .map_err(|_| "BranchLab isn't running — board writes need the app open".to_string())?;
    let _ = conn.set_read_timeout(Some(std::time::Duration::from_secs(10)));
    writeln!(conn, "{req}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(conn).read_line(&mut line).map_err(|e| e.to_string())?;
    let reply: Value = serde_json::from_str(&line).map_err(|e| format!("bad bridge reply: {e}"))?;
    if reply.get("ok").and_then(|o| o.as_bool()) == Some(true) {
        Ok(reply.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(reply.get("error").and_then(|e| e.as_str()).unwrap_or("bridge error").to_string())
    }
}
