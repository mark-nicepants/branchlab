//! Minimal Rust client for a workspace's OpenCode HTTP + SSE API.
//!
//! The frontend talks to each OpenCode server directly for live chat rendering
//! (see `src/lib/opencode.ts`). This backend client exists so the supervisor
//! can *drive* sessions (send autofix prompts) and *observe* coarse session
//! state over SSE for ALL workspaces — including ones not currently on screen.
//! See AGENTS.md "Architecture & boundaries".

use std::time::Duration;

use futures_util::StreamExt;
use reqwest_eventsource::{Event as EsEvent, EventSource};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A session as returned by `GET /session` / `POST /session`.
#[derive(Debug, Clone, Deserialize)]
pub struct SessionInfo {
    pub id: String,
}

/// One OpenCode todo item (`GET /session/{id}/todo`). Mirrors the frontend `Todo`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Todo {
    pub content: String,
    pub status: String,
    #[serde(default)]
    pub priority: String,
}

/// A decoded SSE frame. We only keep `type` and the raw `properties`; the
/// supervisor pulls the few fields it needs (`sessionID`, `error`, question id).
#[derive(Debug, Clone)]
pub struct BusEvent {
    pub event_type: String,
    pub properties: Value,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("build reqwest client")
}

pub async fn list_sessions(base: &str) -> Result<Vec<SessionInfo>, String> {
    let r = client().get(format!("{base}/session")).send().await.map_err(|e| e.to_string())?;
    r.json::<Vec<SessionInfo>>().await.map_err(|e| e.to_string())
}

pub async fn create_session(base: &str) -> Result<SessionInfo, String> {
    let r = client()
        .post(format!("{base}/session"))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    r.json::<SessionInfo>().await.map_err(|e| e.to_string())
}

pub async fn list_todos(base: &str, session_id: &str) -> Result<Vec<Todo>, String> {
    let r = client().get(format!("{base}/session/{session_id}/todo")).send().await.map_err(|e| e.to_string())?;
    r.json::<Vec<Todo>>().await.map_err(|e| e.to_string())
}

/// Send a user prompt via `prompt_async`. `agent` selects the OpenCode agent
/// (e.g. "build" so the fix can use tools); omit to use the server default.
/// Model/variant are intentionally omitted — the server's configured default
/// is used, which is what the workspace's chat already runs with.
pub async fn send_prompt(base: &str, session_id: &str, text: &str, agent: Option<&str>) -> Result<(), String> {
    let mut body = serde_json::json!({ "parts": [{ "type": "text", "text": text }] });
    if let Some(a) = agent {
        body["agent"] = Value::String(a.to_string());
    }
    let r = client()
        .post(format!("{base}/session/{session_id}/prompt_async"))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("prompt_async failed: HTTP {}", r.status()));
    }
    Ok(())
}

/// Handle for an active SSE subscription. Dropping it aborts the reader task.
pub struct SseHandle {
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for SseHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Subscribe to a server's `/event` SSE stream, invoking `on_event` for every
/// decoded frame. Runs on the shared async runtime and reconnects automatically
/// (via reqwest-eventsource). The returned handle stops the task when dropped.
pub fn subscribe_events<F>(base: &str, on_event: F) -> SseHandle
where
    F: Fn(BusEvent) + Send + 'static,
{
    let url = format!("{base}/event");
    let task = tauri::async_runtime::spawn(async move {
        let mut es = EventSource::get(url);
        while let Some(event) = es.next().await {
            match event {
                Ok(EsEvent::Open) => {}
                Ok(EsEvent::Message(msg)) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&msg.data) {
                        let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string();
                        if !event_type.is_empty() {
                            let properties = v.get("properties").cloned().unwrap_or(Value::Null);
                            on_event(BusEvent { event_type, properties });
                        }
                    }
                }
                // reqwest-eventsource retries transient errors internally and
                // keeps yielding; a terminal condition ends the stream (`None`),
                // exiting the loop. So we simply ignore error frames.
                Err(_) => {}
            }
        }
    });
    SseHandle { task }
}
