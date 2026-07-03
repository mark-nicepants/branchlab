//! The chat manager — orchestrates engine ↔ store ↔ events.
//!
//! Owns per-workspace conversation state, the persistent store, and the turn
//! lifecycle. Engines report via a fan-in channel; the manager's async event
//! loop folds updates into the model, persists, and emits `chat:*` deltas. It
//! also broadcasts a coarse [`TurnEvent`] the supervisor consumes for
//! `workspace:session` / autofix (so there is no second SSE connection).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use agent_client_protocol::schema::v1 as acp;
use serde::Serialize;
use tauri::AppHandle;
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::chat::assembler::{map_config_options, TurnAssembler};
use crate::chat::events;
use crate::chat::model::AssistantEntry;
use crate::chat::model::{
    compute_collapse, Attachment, Block, CollapseSummary, ConfigOption, Conversation, Entry, Seq, SessionReason,
    SystemEntry, SystemKind, TurnOrigin, TurnStatus, UserEntry,
};
use crate::chat::store::ChatDb;
use crate::engine::{acp as acp_engine, EngineCommand, EngineEvent, EngineHandle, PromptInput, StopKind};

/// Coarse per-turn signal for the supervisor (activity + autofix hand-off).
#[derive(Debug, Clone)]
pub struct TurnEvent {
    pub workspace_id: String,
    pub origin: TurnOrigin,
    pub status: TurnStatus,
}

/// The initial payload the frontend loads on mount.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSnapshot {
    pub conversation_id: String,
    pub entries: Vec<Entry>,
    pub head_seq: Seq,
    pub has_more: bool,
    pub config: Vec<ConfigOption>,
    /// Slash commands / skills advertised by the engine. Included here (not just
    /// pushed once via `chat:commands`) so a re-mounted view — switching back to
    /// a workspace whose engine already advertised them — still has them.
    pub commands: Vec<events::CommandInfo>,
}

/// The in-flight assistant turn for a conversation.
struct LiveTurn {
    entry_id: String,
    seq: Seq,
    origin: TurnOrigin,
    started_at: i64,
    streaming: bool,
}

struct ConvState {
    conversation_id: String,
    cwd: PathBuf,
    engine: Option<EngineHandle>,
    ready: bool,
    assembler: TurnAssembler,
    current: Option<LiveTurn>,
    pending_perms: HashMap<String, oneshot::Sender<Option<String>>>,
    config: Vec<ConfigOption>,
    commands: Vec<events::CommandInfo>,
    pending_reason: SessionReason,
    /// Model to re-apply once the next session is `Ready`. Set when we restart
    /// the engine (e.g. on a reasoning change), so the user's chosen model isn't
    /// reset to the engine's default by the fresh session's advertised config.
    desired_model: Option<String>,
}

impl ConvState {
    fn new(conversation_id: String, cwd: PathBuf) -> Self {
        Self {
            conversation_id,
            cwd,
            engine: None,
            ready: false,
            assembler: TurnAssembler::new(),
            current: None,
            pending_perms: HashMap::new(),
            config: Vec::new(),
            commands: Vec::new(),
            pending_reason: SessionReason::Started,
            desired_model: None,
        }
    }
}

struct Inner {
    app: AppHandle,
    db: Mutex<ChatDb>,
    convs: Mutex<HashMap<String, ConvState>>,
    turn_tx: broadcast::Sender<TurnEvent>,
    event_tx: mpsc::UnboundedSender<(String, EngineEvent)>,
}

#[derive(Clone)]
pub struct ChatManager {
    inner: Arc<Inner>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn new_id() -> String {
    ulid::Ulid::new().to_string()
}

impl ChatManager {
    /// Open the store, repair any turns interrupted by a prior crash, and start
    /// the engine-event loop.
    pub fn new(app: AppHandle, db_path: PathBuf) -> Result<Self, String> {
        let db = ChatDb::open(&db_path)?;
        if let Ok(n) = db.fail_active_turns() {
            if n > 0 {
                crate::logf!("chat", "repaired {n} interrupted turn(s) on startup");
            }
        }
        let (turn_tx, _) = broadcast::channel(256);
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner { app, db: Mutex::new(db), convs: Mutex::new(HashMap::new()), turn_tx, event_tx });
        let loop_inner = Arc::clone(&inner);
        tauri::async_runtime::spawn(async move { Inner::event_loop(loop_inner, event_rx).await });
        Ok(Self { inner })
    }

    /// Subscribe to coarse turn transitions (the supervisor uses this instead of
    /// its own OpenCode SSE connection).
    pub fn subscribe_turns(&self) -> broadcast::Receiver<TurnEvent> {
        self.inner.turn_tx.subscribe()
    }

    /// Ensure a conversation + engine exist for a workspace and return its
    /// current snapshot. Called by the frontend on mount.
    pub fn open(&self, workspace_id: &str, cwd: &Path, limit: i64) -> Result<ChatSnapshot, String> {
        self.ensure(workspace_id, cwd)?;
        self.snapshot(workspace_id, None, limit)
    }

    /// Read a page of history (newest `limit`, or before `before_seq`).
    pub fn snapshot(&self, workspace_id: &str, before_seq: Option<Seq>, limit: i64) -> Result<ChatSnapshot, String> {
        let convs = self.inner.convs.lock().unwrap();
        let db = self.inner.db.lock().unwrap();
        let Some(conv) = db.get_conversation(workspace_id)? else {
            return Ok(ChatSnapshot {
                conversation_id: String::new(),
                entries: Vec::new(),
                head_seq: 0,
                has_more: false,
                config: Vec::new(),
                commands: Vec::new(),
            });
        };
        let entries = match before_seq {
            Some(before) => db.entries_before(&conv.id, before, limit)?,
            None => db.recent_entries(&conv.id, limit)?,
        };
        let head_seq = db.head_seq(&conv.id)?;
        let has_more = entries
            .first()
            .map(|e| e.seq())
            .is_some_and(|oldest| db.entries_before(&conv.id, oldest, 1).map(|v| !v.is_empty()).unwrap_or(false));
        let (config, commands) =
            convs.get(workspace_id).map(|c| (c.config.clone(), c.commands.clone())).unwrap_or_default();
        Ok(ChatSnapshot { conversation_id: conv.id, entries, head_seq, has_more, config, commands })
    }

    /// Send a user message. `display` is shown in the UI; `sent` goes to the AI.
    #[allow(clippy::too_many_arguments)]
    pub fn send(
        &self,
        workspace_id: &str,
        cwd: &Path,
        display: String,
        sent: String,
        attachments: Vec<Attachment>,
        origin: TurnOrigin,
        model: Option<String>,
        variant: Option<String>,
        agent: Option<String>,
    ) -> Result<(), String> {
        self.ensure(workspace_id, cwd)?;
        let mut convs = self.inner.convs.lock().unwrap();
        let conv = convs.get_mut(workspace_id).ok_or("no conversation")?;
        if conv.current.is_some() {
            return Err("a turn is already in progress".into());
        }
        let now = now_ms();

        // Persist + emit the user message (we own it — ACP does not echo it back).
        let user = Entry::User(UserEntry {
            seq: 0,
            entry_id: new_id(),
            display,
            sent: sent.clone(),
            attachments: attachments.clone(),
            model,
            variant,
            agent,
            origin,
            created_at: now,
        });
        let assistant_id = new_id();
        let (user_seq, assistant_seq) = {
            let db = self.inner.db.lock().unwrap();
            let us = db.insert_entry(&conv.conversation_id, &user)?;
            let assistant = Entry::Assistant(AssistantEntry {
                seq: 0,
                entry_id: assistant_id.clone(),
                engine_session_id: None,
                status: TurnStatus::Queued,
                origin,
                blocks: Vec::new(),
                summary: CollapseSummary::default(),
                usage: None,
                started_at: now,
                ended_at: None,
            });
            let asq = db.insert_entry(&conv.conversation_id, &assistant)?;
            (us, asq)
        };
        events::emit_entry(&self.inner.app, workspace_id, &with_seq(user, user_seq));
        let assistant = Entry::Assistant(AssistantEntry {
            seq: assistant_seq,
            entry_id: assistant_id.clone(),
            engine_session_id: None,
            status: TurnStatus::Queued,
            origin,
            blocks: Vec::new(),
            summary: CollapseSummary::default(),
            usage: None,
            started_at: now,
            ended_at: None,
        });
        events::emit_entry(&self.inner.app, workspace_id, &assistant);

        conv.assembler = TurnAssembler::new();
        conv.current = Some(LiveTurn {
            entry_id: assistant_id.clone(),
            seq: assistant_seq,
            origin,
            started_at: now,
            streaming: false,
        });

        let inputs = build_inputs(&sent, &attachments);
        crate::logf!("chat", "send ws={workspace_id} origin={origin:?} ready={} sent_len={}", conv.ready, sent.len());
        if let Some(engine) = &conv.engine {
            engine.send(EngineCommand::Prompt { entry_id: assistant_id, inputs });
        }
        let _ = self.inner.turn_tx.send(TurnEvent {
            workspace_id: workspace_id.to_string(),
            origin,
            status: TurnStatus::Queued,
        });
        Ok(())
    }

    /// Generate an AI title from the first message via a throwaway session on the
    /// workspace's existing ACP connection. Returns None on failure (caller
    /// falls back to a deterministic title).
    pub async fn generate_title(&self, workspace_id: &str, cwd: &Path, text: String) -> Option<String> {
        self.ensure(workspace_id, cwd).ok()?;
        let rx = {
            let convs = self.inner.convs.lock().unwrap();
            let engine = convs.get(workspace_id)?.engine.as_ref()?;
            let (tx, rx) = oneshot::channel();
            engine.send(EngineCommand::GenerateTitle { text, reply: tx });
            rx
        };
        rx.await.ok().flatten()
    }

    pub fn abort(&self, workspace_id: &str) {
        let mut convs = self.inner.convs.lock().unwrap();
        if let Some(conv) = convs.get_mut(workspace_id) {
            if let Some(engine) = &conv.engine {
                engine.send(EngineCommand::Cancel);
            }
            // Resolve pending permissions so the ACP responders unblock.
            for (_id, tx) in conv.pending_perms.drain() {
                let _ = tx.send(None);
            }
        }
    }

    pub fn set_config(&self, workspace_id: &str, id: String, value: String) {
        // Apply optimistically to our own config snapshot and echo it to the UI
        // immediately. opencode does not reliably emit a config_option_update in
        // response to set_config (especially outside a turn), so relying on it
        // left the selector snapping back to the old value (the §3.4 FAIL).
        let (config_snapshot, conv_id, change) = {
            let mut convs = self.inner.convs.lock().unwrap();
            let Some(conv) = convs.get_mut(workspace_id) else {
                return;
            };
            let mut change = None;
            for opt in conv.config.iter_mut() {
                if opt.id == id {
                    if opt.current_value != value {
                        let choice_name = opt
                            .choices
                            .iter()
                            .find(|c| c.value == value)
                            .map(|c| c.name.clone())
                            .unwrap_or(value.clone());
                        change = Some((opt.name.clone(), choice_name));
                        opt.current_value = value.clone();
                    }
                    break;
                }
            }
            if let Some(engine) = &conv.engine {
                engine.send(EngineCommand::SetConfig { id: id.clone(), value: value.clone() });
            }
            (conv.config.clone(), conv.conversation_id.clone(), change)
        };
        crate::logf!("chat", "set_config ws={workspace_id} id={id} value={value} changed={}", change.is_some());
        events::emit_config(&self.inner.app, workspace_id, &config_snapshot);
        // Record the change in the transcript so the user knows a later turn may
        // behave differently (§3.7 request).
        if let Some((opt_name, choice_name)) = change {
            self.inner.push_system(workspace_id, &conv_id, SystemKind::Info, format!("{opt_name} → {choice_name}"));
        }
    }

    pub fn answer_permission(&self, workspace_id: &str, request_id: &str, option_id: Option<String>) {
        let mut convs = self.inner.convs.lock().unwrap();
        if let Some(conv) = convs.get_mut(workspace_id) {
            if let Some(tx) = conv.pending_perms.remove(request_id) {
                let _ = tx.send(option_id);
            }
        }
    }

    /// Start a fresh engine session for a workspace, keeping all prior entries.
    /// Used for compact / clear / manual reset.
    pub fn new_session(&self, workspace_id: &str, cwd: &Path, reason: SessionReason) -> Result<(), String> {
        let note = match reason {
            SessionReason::Compacted => "Context compacted — new engine session (history kept).",
            SessionReason::Cleared => "Engine restarted — new session (history kept).",
            _ => "Engine restarted.",
        };
        self.restart_engine(workspace_id, cwd, reason, note.to_string())
    }

    /// Drop + respawn the engine (new ACP session), keep all entries, and record
    /// `note` in the transcript so the user knows the underlying engine changed.
    fn restart_engine(
        &self,
        workspace_id: &str,
        cwd: &Path,
        reason: SessionReason,
        note: String,
    ) -> Result<(), String> {
        let conv_id = {
            let mut convs = self.inner.convs.lock().unwrap();
            let cid = convs.get(workspace_id).map(|c| c.conversation_id.clone());
            if let Some(conv) = convs.get_mut(workspace_id) {
                // Remember the selected model so the fresh session doesn't reset
                // it to the engine's default (the reasoning-change reset bug).
                conv.desired_model = conv
                    .config
                    .iter()
                    .find(|o| o.category.as_deref() == Some("model"))
                    .map(|o| o.current_value.clone());
                conv.engine = None; // Drop → Shutdown + abort the old opencode acp
                conv.ready = false;
                conv.current = None;
                conv.pending_reason = reason;
            }
            cid
        };
        // Insert the note before re-ensuring so it lands in the reloaded snapshot.
        if let Some(cid) = conv_id {
            self.inner.push_system(workspace_id, &cid, SystemKind::Info, note);
        }
        crate::logf!("chat", "restart engine ws={workspace_id} reason={reason:?}");
        self.ensure(workspace_id, cwd)?;
        events::emit_reset(&self.inner.app, workspace_id);
        Ok(())
    }

    fn ensure(&self, workspace_id: &str, cwd: &Path) -> Result<(), String> {
        let mut convs = self.inner.convs.lock().unwrap();
        if !convs.contains_key(workspace_id) {
            let (conv_id, has_sessions) = {
                let db = self.inner.db.lock().unwrap();
                match db.get_conversation(workspace_id)? {
                    Some(c) => {
                        let has = !db.list_engine_sessions(&c.id)?.is_empty();
                        (c.id, has)
                    }
                    None => {
                        let id = new_id();
                        db.create_conversation(&Conversation {
                            id: id.clone(),
                            workspace_id: workspace_id.to_string(),
                            title: None,
                            created_at: now_ms(),
                            active_engine_session: None,
                        })?;
                        (id, false)
                    }
                }
            };
            let mut state = ConvState::new(conv_id, cwd.to_path_buf());
            state.pending_reason = if has_sessions { SessionReason::Reloaded } else { SessionReason::Started };
            convs.insert(workspace_id.to_string(), state);
        }
        let conv = convs.get_mut(workspace_id).unwrap();
        if conv.engine.is_none() {
            crate::logf!("chat", "spawn engine ws={workspace_id} cwd={}", conv.cwd.display());
            let handle =
                acp_engine::spawn_engine(workspace_id.to_string(), conv.cwd.clone(), self.inner.event_tx.clone());
            conv.engine = Some(handle);
            conv.ready = false;
        }
        Ok(())
    }
}

impl Inner {
    async fn event_loop(inner: Arc<Inner>, mut rx: mpsc::UnboundedReceiver<(String, EngineEvent)>) {
        while let Some((ws, ev)) = rx.recv().await {
            inner.handle_event(&ws, ev);
        }
    }

    /// Insert + emit a System entry (lifecycle notice, config change, error).
    /// Persisted so it survives reloads/restarts.
    fn push_system(&self, workspace_id: &str, conversation_id: &str, kind: SystemKind, text: String) {
        let entry = Entry::System(SystemEntry { seq: 0, entry_id: new_id(), kind, text, created_at: now_ms() });
        let seq = { self.db.lock().unwrap().insert_entry(conversation_id, &entry).unwrap_or(0) };
        events::emit_entry(&self.app, workspace_id, &with_seq(entry, seq));
    }

    fn handle_event(self: &Arc<Inner>, ws: &str, ev: EngineEvent) {
        match ev {
            EngineEvent::Ready { session_id, config } => {
                let mut convs = self.convs.lock().unwrap();
                let Some(conv) = convs.get_mut(ws) else { return };
                conv.ready = true;
                conv.config = config;
                // Enforce the desired model over ACP. opencode ACP always starts
                // at its own built-in default (e.g. `opencode/big-pickle`) and
                // ignores the config's top-level `model`, so we set it explicitly.
                // Priority: a model selected before a restart (reasoning-change
                // reset) wins; otherwise the global default model for all
                // workspaces. `SetConfig` over ACP is honored (unlike reasoning).
                let desired = conv
                    .desired_model
                    .take()
                    .or_else(|| crate::config::get_default_model(&crate::config::global_dir()));
                if let Some(desired) = desired {
                    if let Some(model_opt) = conv.config.iter_mut().find(|o| o.category.as_deref() == Some("model")) {
                        if model_opt.current_value != desired && model_opt.choices.iter().any(|c| c.value == desired) {
                            model_opt.current_value = desired.clone();
                            if let Some(engine) = &conv.engine {
                                engine.send(EngineCommand::SetConfig { id: model_opt.id.clone(), value: desired });
                            }
                        }
                    }
                }
                {
                    let db = self.db.lock().unwrap();
                    let _ = db.add_engine_session(
                        &conv.conversation_id,
                        &session_id,
                        "opencode",
                        conv.pending_reason,
                        now_ms(),
                    );
                }
                events::emit_config(&self.app, ws, &conv.config);
            }
            EngineEvent::Update(u) => self.handle_update(ws, *u),
            EngineEvent::TurnEnded { stop } => self.finish_turn(ws, stop),
            EngineEvent::Permission { req, reply } => {
                let mut convs = self.convs.lock().unwrap();
                let Some(conv) = convs.get_mut(ws) else {
                    let _ = reply.send(None);
                    return;
                };
                let Some(cur) = &conv.current else {
                    let _ = reply.send(None);
                    return;
                };
                let seq = cur.seq;
                let origin = cur.origin;
                conv.pending_perms.insert(req.request_id.clone(), reply);
                let _ = self.turn_tx.send(TurnEvent {
                    workspace_id: ws.to_string(),
                    origin,
                    status: TurnStatus::AwaitingPermission,
                });
                let options: Vec<events::PermChoiceDto> = req
                    .options
                    .iter()
                    .map(|o| events::PermChoiceDto {
                        option_id: o.option_id.clone(),
                        name: o.name.clone(),
                        kind: o.kind.clone(),
                    })
                    .collect();
                events::emit_permission(
                    &self.app,
                    ws,
                    seq,
                    &req.request_id,
                    &req.tool_call_id,
                    req.title.as_deref(),
                    &options,
                );
            }
            EngineEvent::Error(e) => {
                crate::logf!("chat", "engine error ws={ws}: {e}");
                self.finish_turn(ws, StopKind::Error(e));
            }
            EngineEvent::Closed => {
                let mut convs = self.convs.lock().unwrap();
                if let Some(conv) = convs.get_mut(ws) {
                    conv.engine = None;
                    conv.ready = false;
                }
                drop(convs);
                // If a turn was live when the process died, fail it.
                self.finish_turn(ws, StopKind::Error("engine closed".into()));
            }
        }
    }

    fn handle_update(self: &Arc<Inner>, ws: &str, update: acp::SessionUpdate) {
        let mut convs = self.convs.lock().unwrap();
        let Some(conv) = convs.get_mut(ws) else { return };

        // Block-producing updates fold into the live turn via the assembler.
        if conv.current.is_some() {
            if let Some(delta) = conv.assembler.apply(&update) {
                if let Some(cur) = &mut conv.current {
                    let seq = cur.seq;
                    let started = !cur.streaming;
                    cur.streaming = true;
                    // For streaming text, send only the incremental `textAppend`
                    // (thin the block's text) so we don't resend the growing
                    // prose each chunk; the frontend appends. Whole-block updates
                    // (new block, tool updates) send the full block.
                    let full = &conv.assembler.blocks[delta.index];
                    // opencode surfaces the plan/todo list as a `todowrite` tool
                    // call (not an ACP `Plan`), so drive the composer's TodoButton
                    // from the tool's `todos` input (§NOTES).
                    let todos = todos_from_block(full);
                    let (block, append) = match &delta.text_append {
                        Some(app) => (thin_text(full), Some(app.as_str())),
                        None => (full.clone(), None),
                    };
                    events::emit_block(&self.app, ws, seq, &block, append);
                    if let Some(todos) = todos {
                        crate::logf!("chat", "todos from tool ws={ws} n={}", todos.len());
                        events::emit_todos(&self.app, ws, &todos);
                    }
                    if started {
                        let origin = cur.origin;
                        let _ = self.turn_tx.send(TurnEvent {
                            workspace_id: ws.to_string(),
                            origin,
                            status: TurnStatus::Streaming,
                        });
                    }
                }
            }
        }

        // Non-block updates: plan/todos, config, usage/context, commands.
        match &update {
            acp::SessionUpdate::Plan(p) => {
                let todos = map_plan(p);
                crate::logf!("chat", "todos from ACP Plan ws={ws} n={}", todos.len());
                events::emit_todos(&self.app, ws, &todos);
            }
            acp::SessionUpdate::ConfigOptionUpdate(c) => {
                conv.config = map_config_options(&c.config_options);
                crate::logf!(
                    "chat",
                    "config update ws={ws} options=[{}]",
                    conv.config
                        .iter()
                        .map(|o| format!("{}({:?})={}", o.id, o.category.as_deref().unwrap_or("-"), o.current_value))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                events::emit_config(&self.app, ws, &conv.config);
            }
            acp::SessionUpdate::UsageUpdate(u) => {
                events::emit_context(&self.app, ws, u.used, u.size);
            }
            acp::SessionUpdate::AvailableCommandsUpdate(c) => {
                let cmds: Vec<events::CommandInfo> = c
                    .available_commands
                    .iter()
                    .map(|a| events::CommandInfo { name: a.name.clone(), description: a.description.clone() })
                    .collect();
                crate::logf!("chat", "commands ws={ws} n={}", cmds.len());
                // Cache on the conversation so a later snapshot (re-open / switch
                // back) carries them even though opencode only pushes them once.
                conv.commands = cmds.clone();
                events::emit_commands(&self.app, ws, &cmds);
            }
            _ => {}
        }
    }

    fn finish_turn(self: &Arc<Inner>, ws: &str, stop: StopKind) {
        let mut convs = self.convs.lock().unwrap();
        let Some(conv) = convs.get_mut(ws) else { return };
        let Some(cur) = conv.current.take() else { return };
        let conv_id = conv.conversation_id.clone();
        // A failed turn carries a reason we surface in the transcript (§3.5) so
        // the user sees *why* it failed instead of a silent stop.
        let (status, err_text) = match &stop {
            StopKind::Completed => (TurnStatus::Completed, None),
            StopKind::Cancelled => (TurnStatus::Cancelled, None),
            StopKind::Refusal => (TurnStatus::Failed, Some("The agent declined to continue.".to_string())),
            StopKind::Error(e) => (TurnStatus::Failed, Some(e.clone())),
        };
        let assembler = std::mem::take(&mut conv.assembler);
        let blocks = assembler.blocks;
        let summary = compute_collapse(&blocks, true);
        let now = now_ms();
        let entry = Entry::Assistant(AssistantEntry {
            seq: cur.seq,
            entry_id: cur.entry_id.clone(),
            engine_session_id: None,
            status,
            origin: cur.origin,
            blocks,
            summary: summary.clone(),
            usage: None,
            started_at: cur.started_at,
            ended_at: Some(now),
        });
        {
            let db = self.db.lock().unwrap();
            let _ = db.update_entry(&entry);
        }
        // Resolve any dangling permissions.
        for (_id, tx) in conv.pending_perms.drain() {
            let _ = tx.send(None);
        }
        let origin = cur.origin;
        drop(convs);
        events::emit_turn(&self.app, ws, cur.seq, status, &summary, None);
        if let Some(text) = err_text {
            crate::logf!("chat", "turn failed ws={ws} seq={}: {text}", cur.seq);
            self.push_system(ws, &conv_id, SystemKind::Error, format!("Turn failed: {text}"));
        }
        let _ = self.turn_tx.send(TurnEvent { workspace_id: ws.to_string(), origin, status });
    }
}

/// Strip the accumulated text from a streaming text/reasoning block so a
/// `chat:block` delta carries only the incremental `textAppend`, not the whole
/// growing string. Non-text blocks are returned unchanged.
fn thin_text(b: &Block) -> Block {
    match b {
        Block::Text { block_id, .. } => Block::Text { block_id: block_id.clone(), text: String::new() },
        Block::Reasoning { block_id, .. } => Block::Reasoning { block_id: block_id.clone(), text: String::new() },
        other => other.clone(),
    }
}

fn with_seq(mut entry: Entry, seq: Seq) -> Entry {
    match &mut entry {
        Entry::User(e) => e.seq = seq,
        Entry::Assistant(e) => e.seq = seq,
        Entry::System(e) => e.seq = seq,
    }
    entry
}

fn build_inputs(sent: &str, attachments: &[Attachment]) -> Vec<PromptInput> {
    let mut inputs = Vec::new();
    for a in attachments {
        if let Some((mime, data)) = parse_data_url(&a.url) {
            inputs.push(PromptInput::Image { mime, data });
        }
    }
    if !sent.is_empty() {
        inputs.push(PromptInput::Text(sent.to_string()));
    }
    inputs
}

fn parse_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mime = meta.split(';').next().unwrap_or("application/octet-stream").to_string();
    Some((mime, data.to_string()))
}

/// Extract a todo list from a tool block that carries a `todos` array in its
/// input (opencode's `todowrite`). Keyed on the input shape, not the tool name,
/// since ACP reports it as `ToolKind::Other` with an engine-chosen title.
fn todos_from_block(b: &Block) -> Option<Vec<events::Todo>> {
    let Block::Tool(t) = b else {
        return None;
    };
    let arr = t.input.get("todos")?.as_array()?;
    let todos = arr
        .iter()
        .map(|v| events::Todo {
            content: v.get("content").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
            status: v.get("status").and_then(|x| x.as_str()).unwrap_or("pending").to_string(),
            priority: v.get("priority").and_then(|x| x.as_str()).unwrap_or("medium").to_string(),
        })
        .collect();
    Some(todos)
}

fn map_plan(p: &acp::Plan) -> Vec<events::Todo> {
    p.entries
        .iter()
        .map(|e| events::Todo {
            content: e.content.clone(),
            status: match e.status {
                acp::PlanEntryStatus::Pending => "pending",
                acp::PlanEntryStatus::InProgress => "in_progress",
                acp::PlanEntryStatus::Completed => "completed",
                _ => "pending",
            }
            .to_string(),
            priority: match e.priority {
                acp::PlanEntryPriority::High => "high",
                acp::PlanEntryPriority::Medium => "medium",
                acp::PlanEntryPriority::Low => "low",
                _ => "medium",
            }
            .to_string(),
        })
        .collect()
}
