//! The OpenCode ACP engine: drives `opencode acp` over stdio JSON-RPC.
//!
//! All `agent-client-protocol` crate types are confined to this file. It spawns
//! one subprocess per conversation, forwards streaming `session/update`
//! notifications and permission requests to the manager as [`EngineEvent`]s, and
//! runs a command loop that sends prompts / config changes / cancels. Prompt
//! turns are spawned as their own task so a cancel or config change can be sent
//! while a turn is in flight (JSON-RPC allows concurrent in-flight requests).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, ImageContent, InitializeRequest, NewSessionRequest, PermissionOptionKind,
    PromptRequest, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionConfigId, SessionConfigValueId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, StopReason, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, ConnectionTo};
use tokio::sync::{mpsc, oneshot};

use crate::chat::assembler::map_config_options;
use crate::engine::{EngineCommand, EngineEvent, EngineHandle, PermChoice, PermissionReq, PromptInput, StopKind};

/// Start an `opencode acp` engine for a workspace. Returns immediately; the
/// connection is established on the async runtime and reports readiness via an
/// `EngineEvent::Ready` on `event_tx`. Events are tagged with `workspace_id`.
pub fn spawn_engine(
    workspace_id: String,
    cwd: PathBuf,
    event_tx: mpsc::UnboundedSender<(String, EngineEvent)>,
) -> EngineHandle {
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<EngineCommand>();
    let ws = workspace_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        if let Err(e) = run_connection(ws.clone(), cwd, event_tx.clone(), cmd_rx).await {
            let _ = event_tx.send((ws.clone(), EngineEvent::Error(e)));
        }
        let _ = event_tx.send((ws, EngineEvent::Closed));
    });
    EngineHandle::new(cmd_tx, task)
}

async fn run_connection(
    ws: String,
    cwd: PathBuf,
    event_tx: mpsc::UnboundedSender<(String, EngineEvent)>,
    cmd_rx: mpsc::UnboundedReceiver<EngineCommand>,
) -> Result<(), String> {
    let agent = agent_client_protocol::AcpAgent::from_args([
        "opencode".to_string(),
        "acp".to_string(),
        "--cwd".to_string(),
        cwd.to_string_lossy().into_owned(),
    ])
    .map_err(|e| format!("build acp agent: {e}"))?;

    // Buffers for throwaway "title" sessions opened on this same connection:
    // their session/update text is collected here (not forwarded to the manager
    // as transcript). Shared between the notification callback and the loop.
    let title_bufs: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));

    let notif_tx = event_tx.clone();
    let notif_ws = ws.clone();
    let notif_bufs = Arc::clone(&title_bufs);
    let perm_tx = event_tx.clone();
    let perm_ws = ws.clone();
    let loop_tx = event_tx.clone();
    let loop_ws = ws.clone();

    agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            move |n: SessionNotification, _cx| {
                let tx = notif_tx.clone();
                let ws = notif_ws.clone();
                let bufs = Arc::clone(&notif_bufs);
                async move {
                    // If this update belongs to a title session, collect its text
                    // instead of forwarding it as transcript.
                    let sid = n.session_id.0.to_string();
                    {
                        let mut guard = bufs.lock().unwrap();
                        if let Some(buf) = guard.get_mut(&sid) {
                            if let SessionUpdate::AgentMessageChunk(c) = &n.update {
                                if let ContentBlock::Text(t) = &c.content {
                                    buf.push_str(&t.text);
                                }
                            }
                            return Ok(());
                        }
                    }
                    // Log non-chunk updates (chunks are per-token and too noisy)
                    // so we can see exactly what opencode emits — plans, tool
                    // calls, config/mode updates — while reproducing an issue.
                    if let Some(label) = describe_update(&n.update) {
                        crate::logf!("acp", "update ws={ws} {label}");
                    }
                    let _ = tx.send((ws, EngineEvent::Update(Box::new(n.update))));
                    Ok(())
                }
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            move |req: RequestPermissionRequest,
                  responder: agent_client_protocol::Responder<RequestPermissionResponse>,
                  _conn| {
                let tx = perm_tx.clone();
                let ws = perm_ws.clone();
                async move {
                    let (reply_tx, reply_rx) = oneshot::channel::<Option<String>>();
                    let pr = to_permission_req(&req);
                    crate::logf!(
                        "acp",
                        "permission ws={ws} tool={} title={:?} options=[{}]",
                        pr.tool_call_id,
                        pr.title,
                        pr.options.iter().map(|o| o.name.clone()).collect::<Vec<_>>().join(", ")
                    );
                    let _ = tx.send((ws, EngineEvent::Permission { req: pr, reply: reply_tx }));
                    // Await the user's answer routed back by the manager; a dropped
                    // sender (e.g. abort) resolves to a cancel.
                    let outcome = reply_rx.await.ok().flatten();
                    let resp = match outcome {
                        Some(id) => RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
                            SelectedPermissionOutcome::new(id),
                        )),
                        None => RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled),
                    };
                    responder.respond(resp)
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, move |conn: ConnectionTo<Agent>| async move {
            run_loop(conn, cwd, loop_tx, loop_ws, cmd_rx, title_bufs).await
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn run_loop(
    conn: ConnectionTo<Agent>,
    cwd: PathBuf,
    event_tx: mpsc::UnboundedSender<(String, EngineEvent)>,
    ws: String,
    mut cmd_rx: mpsc::UnboundedReceiver<EngineCommand>,
    title_bufs: Arc<Mutex<HashMap<String, String>>>,
) -> Result<(), agent_client_protocol::Error> {
    conn.send_request(InitializeRequest::new(ProtocolVersion::V1)).block_task().await?;
    let ns = conn.send_request(NewSessionRequest::new(cwd.clone())).block_task().await?;
    let session_id = ns.session_id.clone();
    let config = ns.config_options.as_deref().map(map_config_options).unwrap_or_default();
    crate::logf!(
        "acp",
        "ready ws={ws} session={} config_options=[{}]",
        session_id.0,
        config.iter().map(|c| format!("{}={}", c.id, c.current_value)).collect::<Vec<_>>().join(", ")
    );
    let _ = event_tx.send((ws.clone(), EngineEvent::Ready { session_id: session_id.0.to_string(), config }));

    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            EngineCommand::GenerateTitle { text, reply } => {
                let conn2 = conn.clone();
                let cwd2 = cwd.clone();
                let bufs = Arc::clone(&title_bufs);
                tauri::async_runtime::spawn(async move {
                    let _ = reply.send(generate_title(&conn2, cwd2, &bufs, &text).await);
                });
            }
            EngineCommand::Prompt { inputs, .. } => {
                let content: Vec<ContentBlock> = inputs.into_iter().map(to_content_block).collect();
                let conn2 = conn.clone();
                let tx2 = event_tx.clone();
                let ws2 = ws.clone();
                let sid = session_id.clone();
                tauri::async_runtime::spawn(async move {
                    let stop = match conn2.send_request(PromptRequest::new(sid, content)).block_task().await {
                        Ok(r) => map_stop(r.stop_reason),
                        Err(e) => StopKind::Error(e.to_string()),
                    };
                    crate::logf!("acp", "turn ended ws={ws2} stop={stop:?}");
                    let _ = tx2.send((ws2, EngineEvent::TurnEnded { stop }));
                });
            }
            EngineCommand::SetConfig { id, value } => {
                // The manager already applied this optimistically to the UI. The
                // response carries the authoritative refreshed option set — and
                // it is the ONLY place dynamic options appear (opencode adds an
                // `effort` thought-level option when a variant-capable model is
                // selected, without emitting a config_option_update), so we
                // forward it to the manager.
                match conn
                    .send_request(SetSessionConfigOptionRequest::new(
                        session_id.clone(),
                        SessionConfigId::new(id.clone()),
                        SessionConfigValueId::new(value.clone()),
                    ))
                    .block_task()
                    .await
                {
                    Ok(resp) => {
                        let config = map_config_options(&resp.config_options);
                        crate::logf!(
                            "acp",
                            "set_config ok ws={ws} id={id} value={value} -> options=[{}]",
                            config
                                .iter()
                                .map(|o| format!("{}={}", o.id, o.current_value))
                                .collect::<Vec<_>>()
                                .join(", ")
                        );
                        let _ = event_tx.send((ws.clone(), EngineEvent::ConfigChanged(config)));
                    }
                    Err(e) => crate::logf!("acp", "set_config ERR ws={ws} id={id} value={value}: {e}"),
                }
            }
            EngineCommand::Cancel => {
                let _ = conn.send_notification(CancelNotification::new(session_id.clone()));
            }
            EngineCommand::Shutdown => break,
        }
    }
    Ok(())
}

/// Generate a short title via a throwaway session on the same ACP connection.
/// The session's streamed text is captured in `title_bufs` by the notification
/// callback (keyed by the new session id) rather than surfacing as transcript.
async fn generate_title(
    conn: &ConnectionTo<Agent>,
    cwd: PathBuf,
    title_bufs: &Arc<Mutex<HashMap<String, String>>>,
    text: &str,
) -> Option<String> {
    let ns = conn.send_request(NewSessionRequest::new(cwd)).block_task().await.ok()?;
    let sid = ns.session_id.0.to_string();
    title_bufs.lock().unwrap().insert(sid.clone(), String::new());
    let prompt = format!(
        "Write a concise 3-6 word title (Title Case, no surrounding quotes, no trailing punctuation) \
         for a coding session that starts with this message:\n\n{text}"
    );
    let _ = conn
        .send_request(PromptRequest::new(ns.session_id, vec![ContentBlock::Text(TextContent::new(prompt))]))
        .block_task()
        .await;
    let raw = title_bufs.lock().unwrap().remove(&sid).unwrap_or_default();
    let title = raw.trim().trim_matches('"').trim().lines().next().unwrap_or("").trim().to_string();
    if title.is_empty() {
        None
    } else {
        Some(title.chars().take(60).collect())
    }
}

/// A concise one-line label for a session update, for the debug log. Returns
/// `None` for per-token message/thought/user chunks (too noisy to log each).
fn describe_update(u: &SessionUpdate) -> Option<String> {
    Some(match u {
        SessionUpdate::AgentMessageChunk(_)
        | SessionUpdate::AgentThoughtChunk(_)
        | SessionUpdate::UserMessageChunk(_) => {
            return None;
        }
        SessionUpdate::ToolCall(tc) => {
            format!("ToolCall id={} kind={:?} title={:?}", tc.tool_call_id.0, tc.kind, tc.title)
        }
        SessionUpdate::ToolCallUpdate(u) => {
            format!("ToolCallUpdate id={} status={:?}", u.tool_call_id.0, u.fields.status)
        }
        SessionUpdate::Plan(p) => format!("Plan entries={}", p.entries.len()),
        SessionUpdate::AvailableCommandsUpdate(c) => {
            format!("AvailableCommandsUpdate n={}", c.available_commands.len())
        }
        SessionUpdate::CurrentModeUpdate(_) => "CurrentModeUpdate".to_string(),
        SessionUpdate::ConfigOptionUpdate(c) => format!("ConfigOptionUpdate options={}", c.config_options.len()),
        SessionUpdate::SessionInfoUpdate(s) => format!("SessionInfoUpdate title={:?}", s.title),
        SessionUpdate::UsageUpdate(u) => format!("UsageUpdate used={} size={}", u.used, u.size),
        _ => "other".to_string(),
    })
}

fn to_content_block(p: PromptInput) -> ContentBlock {
    match p {
        PromptInput::Text(t) => ContentBlock::Text(TextContent::new(t)),
        PromptInput::Image { mime, data } => ContentBlock::Image(ImageContent::new(data, mime)),
    }
}

fn map_stop(s: StopReason) -> StopKind {
    match s {
        StopReason::Cancelled => StopKind::Cancelled,
        StopReason::Refusal => StopKind::Refusal,
        // EndTurn, MaxTokens, MaxTurnRequests (and future variants) = a normal finish.
        _ => StopKind::Completed,
    }
}

fn perm_kind(k: PermissionOptionKind) -> String {
    match k {
        PermissionOptionKind::AllowOnce => "allowOnce",
        PermissionOptionKind::AllowAlways => "allowAlways",
        PermissionOptionKind::RejectOnce => "rejectOnce",
        PermissionOptionKind::RejectAlways => "rejectAlways",
        _ => "rejectOnce",
    }
    .to_string()
}

fn to_permission_req(req: &RequestPermissionRequest) -> PermissionReq {
    PermissionReq {
        request_id: ulid::Ulid::new().to_string(),
        tool_call_id: req.tool_call.tool_call_id.0.to_string(),
        title: req.tool_call.fields.title.clone(),
        options: req
            .options
            .iter()
            .map(|o| PermChoice { option_id: o.option_id.0.to_string(), name: o.name.clone(), kind: perm_kind(o.kind) })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::SessionUpdate;

    /// Real end-to-end smoke test against the installed `opencode acp` binary.
    /// Ignored by default (spawns a subprocess, needs opencode auth + network,
    /// costs tokens). Run explicitly:
    ///   cargo test --lib engine::acp::tests::real_roundtrip -- --ignored --nocapture
    #[test]
    #[ignore = "spawns real `opencode acp`; run with --ignored"]
    fn real_roundtrip() {
        let dir = std::env::temp_dir().join(format!("bl-acp-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel::<(String, EngineEvent)>();
        let handle = spawn_engine("ws-e2e".to_string(), dir.clone(), tx);

        tauri::async_runtime::block_on(async move {
            use tokio::time::{timeout, Duration};

            // 1) Handshake: initialize + session/new must yield Ready.
            let mut ready = false;
            let mut config_count = 0usize;
            while let Ok(Some((_ws, ev))) = timeout(Duration::from_secs(40), rx.recv()).await {
                match ev {
                    EngineEvent::Ready { session_id, config } => {
                        eprintln!("READY session={session_id} config_options={}", config.len());
                        config_count = config.len();
                        ready = true;
                        break;
                    }
                    EngineEvent::Error(e) => panic!("engine error before ready: {e}"),
                    EngineEvent::Closed => panic!("engine closed before ready"),
                    _ => {}
                }
            }
            assert!(ready, "did not reach Ready (initialize + session/new) within 40s");
            eprintln!("config options advertised over ACP: {config_count}");

            // 2) One prompt turn. Assert we stream at least one agent text chunk
            //    and reach TurnEnded.
            handle.send(EngineCommand::Prompt {
                entry_id: "e1".to_string(),
                inputs: vec![PromptInput::Text(
                    "Reply with exactly the single word: PONG. No tools, no other text.".to_string(),
                )],
            });

            let mut saw_text = false;
            let mut ended = false;
            while let Ok(Some((_ws, ev))) = timeout(Duration::from_secs(120), rx.recv()).await {
                match ev {
                    EngineEvent::Update(u) => {
                        if let SessionUpdate::AgentMessageChunk(c) = *u {
                            if let agent_client_protocol::schema::v1::ContentBlock::Text(t) = c.content {
                                eprintln!("CHUNK: {}", t.text);
                                saw_text = true;
                            }
                        }
                    }
                    EngineEvent::TurnEnded { stop } => {
                        eprintln!("TURN ENDED: {stop:?}");
                        ended = true;
                        break;
                    }
                    EngineEvent::Error(e) => panic!("engine error during turn: {e}"),
                    EngineEvent::Closed => panic!("engine closed during turn"),
                    _ => {}
                }
            }
            assert!(ended, "turn did not end within 120s");
            assert!(saw_text, "no agent text chunk streamed");
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Real e2e for AI titles: a throwaway session on the same connection yields
    /// a non-empty title. Run:
    ///   cargo test --lib engine::acp::tests::title_roundtrip -- --ignored --nocapture
    #[test]
    #[ignore = "spawns real `opencode acp`; run with --ignored"]
    fn title_roundtrip() {
        let dir = std::env::temp_dir().join(format!("bl-acp-title-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel::<(String, EngineEvent)>();
        let handle = spawn_engine("title".to_string(), dir.clone(), tx);
        tauri::async_runtime::block_on(async move {
            use tokio::time::{timeout, Duration};
            while let Ok(Some((_ws, ev))) = timeout(Duration::from_secs(40), rx.recv()).await {
                if matches!(ev, EngineEvent::Ready { .. }) {
                    break;
                }
            }
            let (reply_tx, reply_rx) = oneshot::channel::<Option<String>>();
            handle.send(EngineCommand::GenerateTitle {
                text: "Add a dark mode toggle to the settings page".to_string(),
                reply: reply_tx,
            });
            let title =
                timeout(Duration::from_secs(90), reply_rx).await.expect("title timed out").expect("reply dropped");
            eprintln!("TITLE = {title:?}");
            let title = title.expect("no title generated");
            assert!(!title.trim().is_empty(), "title should be non-empty");
            assert!(title.len() <= 60);
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Probe: does selecting a reasoning-capable model surface a `thoughtLevel`
    /// config option via ConfigOptionUpdate? Run:
    ///   cargo test --lib engine::acp::tests::probe_reasoning -- --ignored --nocapture
    #[test]
    #[ignore = "spawns real `opencode acp`; diagnostic"]
    fn probe_reasoning() {
        use agent_client_protocol::schema::v1::SessionUpdate;
        let dir = std::env::temp_dir().join(format!("bl-acp-reason-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel::<(String, EngineEvent)>();
        let handle = spawn_engine("probe".to_string(), dir.clone(), tx);
        tauri::async_runtime::block_on(async move {
            use tokio::time::{timeout, Duration};
            // Wait for ready; dump the advertised config; find the model option
            // id + an Opus choice value, then select it and watch for updates
            // (does a `thoughtLevel`-category option appear for a reasoning model?).
            let mut model_id = "model".to_string();
            let mut opus: Option<String> = None;
            while let Ok(Some((_ws, ev))) = timeout(Duration::from_secs(40), rx.recv()).await {
                if let EngineEvent::Ready { config, .. } = ev {
                    eprintln!("READY — {} config option(s) advertised:", config.len());
                    for c in &config {
                        eprintln!(
                            "  id={} category={:?} current={} choices={}",
                            c.id,
                            c.category,
                            c.current_value,
                            c.choices.len()
                        );
                        for ch in &c.choices {
                            eprintln!("      {} | {} | group={:?}", ch.value, ch.name, ch.group);
                        }
                    }
                    if let Some(model) =
                        config.iter().find(|c| c.category.as_deref() == Some("model") || c.id == "model")
                    {
                        model_id = model.id.clone();
                        // Prefer Opus 4.8 (the CLI screenshot's model), else any opus.
                        opus = model
                            .choices
                            .iter()
                            .find(|ch| ch.value.contains("opus-4-8") && !ch.value.contains("fast"))
                            .or_else(|| model.choices.iter().find(|ch| ch.value.to_lowercase().contains("opus")))
                            .map(|ch| ch.value.clone());
                    }
                    break;
                }
            }
            let Some(target) = opus else {
                eprintln!("no reasoning-capable model advertised; nothing to select");
                return;
            };
            eprintln!("selecting model id={model_id} value={target}");
            handle.send(EngineCommand::SetConfig { id: model_id, value: target });

            // Give opencode a moment, then poke candidate variant ids the CLI uses
            // (opencode calls reasoning effort "variant": Default/low/…/max) to see
            // if any is accepted or surfaces a config option over ACP.
            tokio::time::sleep(Duration::from_secs(3)).await;
            for id in ["variant", "thoughtLevel", "thought_level", "reasoning", "reasoningEffort"] {
                eprintln!("trying set_config id={id} value=high");
                handle.send(EngineCommand::SetConfig { id: id.to_string(), value: "high".to_string() });
            }

            let mut ticks = 0;
            while let Ok(Some((_ws, ev))) = timeout(Duration::from_secs(4), rx.recv()).await {
                match ev {
                    EngineEvent::Update(u) => {
                        if let SessionUpdate::ConfigOptionUpdate(c) = *u {
                            eprintln!("CONFIG UPDATE ({} options):", c.config_options.len());
                            for o in &c.config_options {
                                let kind = match &o.kind {
                                    agent_client_protocol::schema::v1::SessionConfigKind::Select(_) => "select",
                                    _ => "NON-SELECT",
                                };
                                eprintln!("  id={} name={:?} category={:?} kind={kind}", o.id.0, o.name, o.category);
                            }
                        } else if let Some(label) = describe_update(&u) {
                            eprintln!("UPDATE {label}");
                        }
                    }
                    EngineEvent::Ready { .. } => eprintln!("EVENT Ready"),
                    EngineEvent::ConfigChanged(config) => {
                        eprintln!("EVENT ConfigChanged ({} options):", config.len());
                        for o in &config {
                            eprintln!("  id={} category={:?} current={}", o.id, o.category, o.current_value);
                        }
                    }
                    EngineEvent::TurnEnded { stop } => eprintln!("EVENT TurnEnded {stop:?}"),
                    EngineEvent::Permission { .. } => eprintln!("EVENT Permission"),
                    EngineEvent::Error(e) => eprintln!("EVENT Error {e}"),
                    EngineEvent::Closed => eprintln!("EVENT Closed"),
                }
                ticks += 1;
                if ticks > 12 {
                    break;
                }
            }
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// End-to-end: selecting a variant-capable model surfaces the dynamic
    /// `effort` (thoughtLevel) option via `ConfigChanged`, and setting it
    /// round-trips. This is the engine chain behind the composer's thinking-
    /// level dropdown. Run:
    ///   cargo test --lib effort_config_roundtrip -- --ignored --nocapture
    #[test]
    #[ignore = "spawns real `opencode acp`"]
    fn effort_config_roundtrip() {
        let dir = std::env::temp_dir().join(format!("bl-acp-effort-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel::<(String, EngineEvent)>();
        let handle = spawn_engine("effort".to_string(), dir.clone(), tx);
        tauri::async_runtime::block_on(async move {
            use tokio::time::{timeout, Duration};
            // Wait for Ready and pick a variant-capable model (an Opus).
            let mut opus: Option<String> = None;
            while let Ok(Some((_ws, ev))) = timeout(Duration::from_secs(40), rx.recv()).await {
                if let EngineEvent::Ready { config, .. } = ev {
                    let model = config.iter().find(|c| c.category.as_deref() == Some("model")).expect("model option");
                    assert!(
                        !config.iter().any(|c| c.category.as_deref() == Some("thoughtLevel")),
                        "default model unexpectedly already has an effort option (fine, but test assumes not)"
                    );
                    opus = model
                        .choices
                        .iter()
                        .find(|ch| ch.value.contains("opus-4-8") && !ch.value.contains("fast"))
                        .or_else(|| model.choices.iter().find(|ch| ch.value.to_lowercase().contains("opus")))
                        .map(|ch| ch.value.clone());
                    break;
                }
            }
            let Some(target) = opus else {
                eprintln!("SKIP: no variant-capable (opus) model advertised");
                return;
            };

            // Select the model → the ConfigChanged from the response must carry
            // the dynamic effort option.
            handle.send(EngineCommand::SetConfig { id: "model".to_string(), value: target.clone() });
            let mut effort_values: Vec<String> = Vec::new();
            while let Ok(Some((_ws, ev))) = timeout(Duration::from_secs(20), rx.recv()).await {
                if let EngineEvent::ConfigChanged(config) = ev {
                    if let Some(eff) = config.iter().find(|c| c.category.as_deref() == Some("thoughtLevel")) {
                        eprintln!(
                            "effort option: id={} current={} choices={:?}",
                            eff.id,
                            eff.current_value,
                            eff.choices.iter().map(|c| c.value.clone()).collect::<Vec<_>>()
                        );
                        effort_values = eff.choices.iter().map(|c| c.value.clone()).collect();
                        assert_eq!(eff.id, "effort");
                        break;
                    }
                }
            }
            assert!(!effort_values.is_empty(), "no thoughtLevel option after selecting {target}");
            assert!(effort_values.contains(&"high".to_string()));

            // Set effort=high → the next ConfigChanged must echo it as current.
            handle.send(EngineCommand::SetConfig { id: "effort".to_string(), value: "high".to_string() });
            let mut confirmed = false;
            while let Ok(Some((_ws, ev))) = timeout(Duration::from_secs(20), rx.recv()).await {
                if let EngineEvent::ConfigChanged(config) = ev {
                    if let Some(eff) = config.iter().find(|c| c.category.as_deref() == Some("thoughtLevel")) {
                        assert_eq!(eff.current_value, "high");
                        confirmed = true;
                        break;
                    }
                }
            }
            assert!(confirmed, "effort=high was not confirmed by a ConfigChanged");
            eprintln!("OK: effort option appeared and set to high");
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Probe: with a thinking budget configured for Opus in the global opencode
    /// config, does a real turn actually produce thinking (AgentThoughtChunk)?
    /// This is the ground truth for "is reasoning being applied?" — the model's
    /// self-report is unreliable. Run:
    ///   cargo test --lib engine::acp::tests::probe_thinking -- --ignored --nocapture
    #[test]
    #[ignore = "spawns real `opencode acp`; sends a real turn (costs tokens)"]
    fn probe_thinking() {
        use agent_client_protocol::schema::v1::SessionUpdate;
        let dir = std::env::temp_dir().join(format!("bl-acp-think-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel::<(String, EngineEvent)>();
        let handle = spawn_engine("think".to_string(), dir.clone(), tx);
        tauri::async_runtime::block_on(async move {
            use tokio::time::{timeout, Duration};
            // 1) Ready → pick the Opus 4.8 model value.
            let mut opus: Option<String> = None;
            let mut model_id = "model".to_string();
            while let Ok(Some((_ws, ev))) = timeout(Duration::from_secs(40), rx.recv()).await {
                if let EngineEvent::Ready { config, .. } = ev {
                    if let Some(m) = config.iter().find(|c| c.category.as_deref() == Some("model")) {
                        model_id = m.id.clone();
                        opus = m
                            .choices
                            .iter()
                            .find(|ch| ch.value == "anthropic/claude-opus-4-8")
                            .map(|ch| ch.value.clone());
                    }
                    break;
                }
            }
            let Some(target) = opus else {
                eprintln!("Opus 4.8 not advertised; can't probe");
                return;
            };
            eprintln!("selecting {target}");
            handle.send(EngineCommand::SetConfig { id: model_id, value: target });
            tokio::time::sleep(Duration::from_secs(2)).await;

            // 2) Send a real turn that would surface reasoning.
            handle.send(EngineCommand::Prompt {
                entry_id: "e1".to_string(),
                inputs: vec![PromptInput::Text(
                    "Reason step by step, then answer: a bat and ball cost $1.10; the bat costs \
                     $1.00 more than the ball. How much is the ball?"
                        .to_string(),
                )],
            });

            // 3) Count thought vs message chunks until the turn ends.
            let mut thoughts = 0usize;
            let mut messages = 0usize;
            let mut first_thought: Option<String> = None;
            loop {
                match timeout(Duration::from_secs(90), rx.recv()).await {
                    Ok(Some((_ws, EngineEvent::Update(u)))) => match *u {
                        SessionUpdate::AgentThoughtChunk(c) => {
                            thoughts += 1;
                            if first_thought.is_none() {
                                if let ContentBlock::Text(t) = &c.content {
                                    first_thought = Some(t.text.chars().take(80).collect());
                                }
                            }
                        }
                        SessionUpdate::AgentMessageChunk(_) => messages += 1,
                        _ => {}
                    },
                    Ok(Some((_ws, EngineEvent::TurnEnded { stop }))) => {
                        eprintln!("turn ended: {stop:?}");
                        break;
                    }
                    Ok(Some((_ws, EngineEvent::Error(e)))) => {
                        eprintln!("error: {e}");
                        break;
                    }
                    _ => break,
                }
            }
            eprintln!("RESULT: thought_chunks={thoughts} message_chunks={messages}");
            eprintln!("first thought: {first_thought:?}");
            eprintln!(
                "=> reasoning is {} through this engine/proxy",
                if thoughts > 0 { "ENGAGED" } else { "NOT engaged" }
            );
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Probe: can we open a SECOND session on the same connection (for AI titles
    /// without a second process)? Run:
    ///   cargo test --lib engine::acp::tests::probe_second_session -- --ignored --nocapture
    #[test]
    #[ignore = "spawns real `opencode acp`; diagnostic"]
    fn probe_second_session() {
        use agent_client_protocol::schema::v1::{
            ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest, SessionUpdate, TextContent,
        };
        let dir = std::env::temp_dir().join(format!("bl-acp-2sess-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cleanup_dir = dir.clone();
        tauri::async_runtime::block_on(async move {
            let agent = agent_client_protocol::AcpAgent::from_args([
                "opencode".to_string(),
                "acp".to_string(),
                "--cwd".to_string(),
                dir.to_string_lossy().into_owned(),
            ])
            .unwrap();
            let (txt_tx, mut txt_rx) = mpsc::unbounded_channel::<(String, String)>();
            let result = agent_client_protocol::Client
                .builder()
                .on_receive_notification(
                    move |n: SessionNotification, _cx| {
                        let tx = txt_tx.clone();
                        async move {
                            if let SessionUpdate::AgentMessageChunk(c) = n.update {
                                if let ContentBlock::Text(t) = c.content {
                                    let _ = tx.send((n.session_id.0.to_string(), t.text));
                                }
                            }
                            Ok(())
                        }
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .connect_with(agent, move |conn: ConnectionTo<Agent>| async move {
                    conn.send_request(InitializeRequest::new(ProtocolVersion::V1)).block_task().await?;
                    let s1 = conn.send_request(NewSessionRequest::new(dir.clone())).block_task().await?.session_id;
                    let s2 = conn.send_request(NewSessionRequest::new(dir.clone())).block_task().await?.session_id;
                    eprintln!("s1={} s2={} distinct={}", s1.0, s2.0, s1.0 != s2.0);
                    // Prompt the SECOND session (title-style) and confirm we can read it.
                    let stop = conn
                        .send_request(PromptRequest::new(
                            s2.clone(),
                            vec![ContentBlock::Text(TextContent::new("Reply with exactly: SECOND".to_string()))],
                        ))
                        .block_task()
                        .await?;
                    eprintln!("second-session prompt stop={:?}", stop.stop_reason);
                    Ok::<(), agent_client_protocol::Error>(())
                })
                .await;
            eprintln!("connect result ok={}", result.is_ok());
            while let Ok(msg) = txt_rx.try_recv() {
                eprintln!("TEXT session={} chunk={:?}", &msg.0[..msg.0.len().min(12)], msg.1);
            }
        });
        let _ = std::fs::remove_dir_all(&cleanup_dir);
    }

    /// Diagnostic probe: dump which `session/update` variants opencode actually
    /// emits (does it auto-title via SessionInfoUpdate? send Plan/Commands/
    /// ConfigOptionUpdate?) and what config-option categories it advertises.
    /// Informs how we restore AI titles / MCP status. Run:
    ///   cargo test --lib engine::acp::tests::probe_updates -- --ignored --nocapture
    #[test]
    #[ignore = "spawns real `opencode acp`; diagnostic"]
    fn probe_updates() {
        use agent_client_protocol::schema::v1::SessionUpdate;
        let dir = std::env::temp_dir().join(format!("bl-acp-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("README.md"), "# Probe\nHello world.\n").unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel::<(String, EngineEvent)>();
        let handle = spawn_engine("probe".to_string(), dir.clone(), tx);
        tauri::async_runtime::block_on(async move {
            use tokio::time::{timeout, Duration};
            handle.send(EngineCommand::Prompt {
                entry_id: "e1".to_string(),
                inputs: vec![PromptInput::Text(
                    "Make a 2-item plan, then read README.md and tell me its title.".to_string(),
                )],
            });
            while let Ok(Some((_ws, ev))) = timeout(Duration::from_secs(120), rx.recv()).await {
                match ev {
                    EngineEvent::Ready { session_id, config } => {
                        eprintln!("READY {session_id}");
                        for c in &config {
                            eprintln!(
                                "  CONFIG id={} category={:?} current={} choices={}",
                                c.id,
                                c.category,
                                c.current_value,
                                c.choices.len()
                            );
                            if c.id == "model" {
                                for ch in c.choices.iter().filter(|ch| {
                                    ch.value.contains("opus")
                                        || ch.value.contains("sonnet")
                                        || ch.value.contains("gpt-5")
                                        || ch.value.contains("o3")
                                }) {
                                    eprintln!("    model choice: {}", ch.value);
                                }
                            }
                        }
                    }
                    EngineEvent::Update(u) => {
                        let label = match *u {
                            SessionUpdate::UserMessageChunk(_) => "UserMessageChunk",
                            SessionUpdate::AgentMessageChunk(ref c) => {
                                eprintln!(
                                    "UPDATE AgentMessageChunk msgId={:?}",
                                    c.message_id.as_ref().map(|m| m.0.to_string())
                                );
                                continue;
                            }
                            SessionUpdate::AgentThoughtChunk(ref c) => {
                                eprintln!(
                                    "UPDATE AgentThoughtChunk msgId={:?}",
                                    c.message_id.as_ref().map(|m| m.0.to_string())
                                );
                                continue;
                            }
                            SessionUpdate::ToolCall(_) => "ToolCall",
                            SessionUpdate::ToolCallUpdate(_) => "ToolCallUpdate",
                            SessionUpdate::Plan(_) => "Plan",
                            SessionUpdate::AvailableCommandsUpdate(_) => "AvailableCommandsUpdate",
                            SessionUpdate::CurrentModeUpdate(_) => "CurrentModeUpdate",
                            SessionUpdate::ConfigOptionUpdate(_) => "ConfigOptionUpdate",
                            SessionUpdate::SessionInfoUpdate(ref s) => {
                                eprintln!("UPDATE SessionInfoUpdate title={:?}", s.title);
                                continue;
                            }
                            SessionUpdate::UsageUpdate(ref u) => {
                                eprintln!("UPDATE UsageUpdate used={} size={}", u.used, u.size);
                                continue;
                            }
                            _ => "other",
                        };
                        eprintln!("UPDATE {label}");
                    }
                    EngineEvent::ConfigChanged(config) => {
                        eprintln!("CONFIG CHANGED ({} options)", config.len());
                    }
                    EngineEvent::TurnEnded { stop } => {
                        eprintln!("TURN ENDED {stop:?}");
                        break;
                    }
                    EngineEvent::Permission { req, reply } => {
                        eprintln!("PERMISSION {} options={}", req.tool_call_id, req.options.len());
                        let _ = reply.send(req.options.first().map(|o| o.option_id.clone()));
                    }
                    EngineEvent::Error(e) => {
                        eprintln!("ERROR {e}");
                        break;
                    }
                    EngineEvent::Closed => break,
                }
            }
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
