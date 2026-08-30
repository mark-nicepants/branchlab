//! The chat manager — orchestrates engine ↔ store ↔ events.
//!
//! Owns per-workspace conversation state, the persistent store, and the turn
//! lifecycle. Engines report via a fan-in channel; the manager's async event
//! loop folds updates into the model, persists, and emits `chat:*` deltas. It
//! also broadcasts a coarse [`TurnEvent`] the supervisor consumes for
//! `workspace:session` / autofix (so there is no second SSE connection).
//!
//! ACP boundary: nothing in `chat/` names an `agent-client-protocol` type. The
//! manager speaks [`EngineEvent`] only; the block-producing updates arrive as
//! the opaque [`RawUpdate`] and are handed straight back to the engine's
//! [`TurnAssembler`] (which the manager owns because it holds the live turn's
//! blocks). Every other update kind arrives pre-digested from `engine/acp.rs`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::AppHandle;
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::chat::events;
use crate::chat::model::AssistantEntry;
use crate::chat::model::{
    compute_collapse, Attachment, Block, CollapseSummary, ConfigOption, Conversation, Entry, Seq, SessionReason,
    SetupStep, SystemEntry, SystemKind, TurnOrigin, TurnStatus, UsageInfo, UserEntry,
};
use crate::chat::store::ChatDb;
use crate::engine::assembler::{RawUpdate, TurnAssembler};
use crate::engine::{acp as acp_engine, EngineCommand, EngineEvent, EngineHandle, PromptInput, StopKind};
use crate::util::LockExt;
use crate::util::{new_id, now_ms};

/// Coarse per-turn signal for the supervisor (activity + autofix hand-off).
#[derive(Debug, Clone)]
pub struct TurnEvent {
    pub workspace_id: String,
    pub origin: TurnOrigin,
    pub status: TurnStatus,
}

/// The initial payload the frontend loads on mount. Mirrors the TS
/// `ChatSnapshot` exactly — don't add fields the frontend doesn't read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSnapshot {
    pub entries: Vec<Entry>,
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
    /// Last time the live blocks were flushed to the store (throttled so token
    /// deltas don't hammer SQLite). `None` until the first flush.
    last_persist: Option<std::time::Instant>,
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
    /// Last todo list pushed via `workspace:todos`, kept so a re-mounted view
    /// can seed itself (events aren't buffered). In-memory only — empty after
    /// an app restart, until the next todowrite/Plan update.
    todos: Vec<events::Todo>,
    pending_reason: SessionReason,
    /// Model to re-apply once the next session is `Ready`. Set when we restart
    /// the engine (e.g. on a reasoning change), so the user's chosen model isn't
    /// reset to the engine's default by the fresh session's advertised config.
    desired_model: Option<String>,
    /// Thought-level (`effort`) to re-apply once the restarted session's model
    /// is set. The effort option is dynamic — it only exists after a
    /// variant-capable model is selected — so it is re-applied from the
    /// `ConfigChanged` that follows the model re-apply, not from `Ready`.
    desired_effort: Option<String>,
    /// A prompt held back while the workspace is still provisioning (worktree
    /// checkout / setup script). The transcript already shows the user entry
    /// and a queued turn; this is just the engine delivery, released by
    /// `release_held` when setup reaches a terminal state.
    held: Option<Vec<PromptInput>>,
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
            todos: Vec::new(),
            pending_reason: SessionReason::Started,
            desired_model: None,
            desired_effort: None,
            held: None,
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
        crate::util::spawn_watched(
            "chat",
            "engine-events",
            async move { Inner::event_loop(loop_inner, event_rx).await },
        );
        Ok(Self { inner })
    }

    /// Drop every live engine — the app is exiting. Each [`EngineHandle`]'s
    /// `Drop` sends `Shutdown` and aborts its connection task, which drops the
    /// ACP crate's `ChildGuard` and kills the `opencode acp` process tree; so
    /// no agent subprocess outlives the window. Mirrors
    /// `ServerManager::shutdown_all`.
    pub fn shutdown_all(&self) {
        let mut convs = self.inner.convs.lock_safe();
        let mut n = 0;
        for conv in convs.values_mut() {
            if conv.engine.take().is_some() {
                n += 1;
            }
            conv.ready = false;
        }
        crate::logf!("chat", "shutdown: dropped {n} engine(s)");
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

    /// Last todo list pushed for the workspace (see `ConvState::todos`).
    pub fn todos(&self, workspace_id: &str) -> Vec<events::Todo> {
        self.inner.convs.lock_safe().get(workspace_id).map(|c| c.todos.clone()).unwrap_or_default()
    }

    /// Read a page of history (newest `limit`, or before `before_seq`).
    pub fn snapshot(&self, workspace_id: &str, before_seq: Option<Seq>, limit: i64) -> Result<ChatSnapshot, String> {
        let convs = self.inner.convs.lock_safe();
        let db = self.inner.db.lock_safe();
        let Some(conv) = db.get_conversation(workspace_id)? else {
            return Ok(ChatSnapshot { entries: Vec::new(), has_more: false, config: Vec::new(), commands: Vec::new() });
        };
        let entries = match before_seq {
            Some(before) => db.entries_before(&conv.id, before, limit)?,
            None => db.recent_entries(&conv.id, limit)?,
        };
        let has_more = entries
            .first()
            .map(|e| e.seq())
            .is_some_and(|oldest| db.entries_before(&conv.id, oldest, 1).map(|v| !v.is_empty()).unwrap_or(false));
        let (config, commands) =
            convs.get(workspace_id).map(|c| (c.config.clone(), c.commands.clone())).unwrap_or_default();
        Ok(ChatSnapshot { entries, has_more, config, commands })
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
        let mut convs = self.inner.convs.lock_safe();
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
            let db = self.inner.db.lock_safe();
            let us = db.insert_entry(&conv.conversation_id, &user)?;
            let assistant = Entry::Assistant(AssistantEntry {
                seq: 0,
                entry_id: assistant_id.clone(),
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
            entry_id: assistant_id,
            seq: assistant_seq,
            origin,
            started_at: now,
            streaming: false,
            last_persist: None,
        });

        let inputs = build_inputs(&sent, &attachments);
        crate::logf!("chat", "send ws={workspace_id} origin={origin:?} ready={} sent_len={}", conv.ready, sent.len());
        let provisioning = {
            use tauri::Manager as _;
            self.inner.app.state::<crate::project::Registry>().setup_state(workspace_id)
                == Some(crate::project::SetupState::Provisioning)
        };
        let mut orphaned = false;
        match dispatch_for(conv.engine.is_some(), provisioning) {
            Dispatch::Deliver => match &conv.engine {
                Some(engine) => engine.send(EngineCommand::Prompt { inputs }),
                None => orphaned = true, // unreachable: Deliver implies an engine
            },
            Dispatch::Hold => conv.held = Some(inputs),
            Dispatch::Orphan => orphaned = true,
        }
        drop(convs);
        let _ = self.inner.turn_tx.send(TurnEvent {
            workspace_id: workspace_id.to_string(),
            origin,
            status: TurnStatus::Queued,
        });
        if orphaned {
            crate::logf!("chat", "send ws={workspace_id}: no engine and not provisioning — failing the turn");
            self.inner.finish_turn(
                workspace_id,
                StopKind::Error("The engine isn't running for this workspace.".into()),
                None,
            );
        }
        Ok(())
    }

    /// Ensure→lock→oneshot→await plumbing shared by the throwaway-session
    /// requests (title, setup proposal, one-shot). None on any failure.
    async fn engine_request<T>(
        &self,
        workspace_id: &str,
        cwd: &Path,
        make: impl FnOnce(oneshot::Sender<Option<T>>) -> EngineCommand,
    ) -> Option<T> {
        self.ensure(workspace_id, cwd).ok()?;
        let rx = {
            let convs = self.inner.convs.lock_safe();
            let engine = convs.get(workspace_id)?.engine.as_ref()?;
            let (tx, rx) = oneshot::channel();
            engine.send(make(tx));
            rx
        };
        rx.await.ok().flatten()
    }

    /// Generate an AI title + branch name from the first message via a
    /// throwaway session on the workspace's existing ACP connection. Returns
    /// None on failure (caller falls back to a deterministic title).
    pub async fn generate_title(
        &self,
        workspace_id: &str,
        cwd: &Path,
        text: String,
    ) -> Option<crate::engine::GeneratedTitle> {
        self.engine_request(workspace_id, cwd, |reply| EngineCommand::GenerateTitle { text, reply }).await
    }

    /// Propose setup/teardown scripts from a pre-collected repo context, via a
    /// throwaway session on the workspace's connection (same as titling).
    pub async fn generate_setup(
        &self,
        workspace_id: &str,
        cwd: &Path,
        context: String,
    ) -> Option<crate::engine::GeneratedSetup> {
        self.engine_request(workspace_id, cwd, |reply| EngineCommand::GenerateSetup { context, reply }).await
    }

    /// One prompt → raw reply text over a throwaway session on the
    /// workspace's engine (booting it if needed). None on any failure.
    pub async fn one_shot(&self, workspace_id: &str, cwd: &Path, prompt: String) -> Option<String> {
        self.engine_request(workspace_id, cwd, |reply| EngineCommand::OneShot { prompt, reply }).await
    }

    pub fn abort(&self, workspace_id: &str) -> Result<(), String> {
        let mut convs = self.inner.convs.lock_safe();
        let conv = convs.get_mut(workspace_id).ok_or("no active conversation for this workspace")?;
        if let Some(engine) = &conv.engine {
            engine.send(EngineCommand::Cancel);
        }
        // Resolve pending permissions so the ACP responders unblock.
        for (_id, tx) in conv.pending_perms.drain() {
            let _ = tx.send(None);
        }
        Ok(())
    }

    pub fn set_config(&self, workspace_id: &str, id: String, value: String) -> Result<(), String> {
        // Apply optimistically to our own config snapshot and echo it to the UI
        // immediately. opencode does not reliably emit a config_option_update in
        // response to set_config (especially outside a turn), so relying on it
        // left the selector snapping back to the old value (the §3.4 FAIL).
        let (config_snapshot, conv_id, change) = {
            let mut convs = self.inner.convs.lock_safe();
            let conv = convs.get_mut(workspace_id).ok_or("no active conversation for this workspace")?;
            let mut change = None;
            for opt in conv.config.iter_mut() {
                if opt.id == id {
                    // Persist the chosen model / thinking level per workspace so
                    // new engine sessions (and model switches) re-apply them.
                    match opt.category.as_deref() {
                        Some("model") => {
                            use tauri::Manager as _;
                            self.inner
                                .app
                                .state::<crate::project::Registry>()
                                .set_workspace_model(workspace_id, Some(value.clone()));
                        }
                        Some("thoughtLevel") => {
                            use tauri::Manager as _;
                            self.inner
                                .app
                                .state::<crate::project::Registry>()
                                .set_workspace_effort(workspace_id, Some(value.clone()));
                        }
                        _ => {}
                    }
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
        Ok(())
    }

    pub fn answer_permission(
        &self,
        workspace_id: &str,
        request_id: &str,
        option_id: Option<String>,
    ) -> Result<(), String> {
        let mut convs = self.inner.convs.lock_safe();
        let conv = convs.get_mut(workspace_id).ok_or("no active conversation for this workspace")?;
        // Already resolved (e.g. by an abort draining the pending set) — the
        // answer had no effect, and the caller should know.
        let tx = conv.pending_perms.remove(request_id).ok_or("permission request is no longer pending")?;
        let _ = tx.send(option_id);
        Ok(())
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
        // A live turn can't survive the engine drop, and its TurnEnded will
        // never arrive — finish it as Cancelled NOW (persisted terminal status
        // + emitted events, same path as an abort), or the reloaded transcript
        // would show a perpetual spinner until the next app launch.
        self.inner.finish_turn(workspace_id, StopKind::Cancelled, None);
        let conv_id = {
            let mut convs = self.inner.convs.lock_safe();
            let cid = convs.get(workspace_id).map(|c| c.conversation_id.clone());
            if let Some(conv) = convs.get_mut(workspace_id) {
                reset_for_restart(conv, reason);
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
        let mut convs = self.inner.convs.lock_safe();
        if !convs.contains_key(workspace_id) {
            let (conv_id, has_sessions) = {
                let db = self.inner.db.lock_safe();
                match db.get_conversation(workspace_id)? {
                    Some(c) => {
                        let has = db.has_engine_sessions(&c.id)?;
                        (c.id, has)
                    }
                    None => {
                        let id = new_id();
                        db.create_conversation(&Conversation {
                            id: id.clone(),
                            workspace_id: workspace_id.to_string(),
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
        // A provisioning workspace's cwd doesn't exist yet — the engine can't
        // boot there. SetupManager re-enters via ensure_engine once the
        // worktree checkout lands.
        if conv.engine.is_none() && conv.cwd.exists() {
            crate::logf!("chat", "spawn engine ws={workspace_id} cwd={}", conv.cwd.display());
            let handle =
                acp_engine::spawn_engine(workspace_id.to_string(), conv.cwd.clone(), self.inner.event_tx.clone());
            conv.engine = Some(handle);
            conv.ready = false;
        }
        Ok(())
    }

    // ── Workspace-setup integration (called by SetupManager) ────────────────

    /// Boot the engine once the worktree exists (ensure's cwd gate passes now).
    pub fn ensure_engine(&self, workspace_id: &str, cwd: &Path) {
        let _ = self.ensure(workspace_id, cwd);
    }

    /// Deliver a prompt held during provisioning. Called on setup success AND
    /// failure — the workspace stays usable either way. If no engine exists to
    /// deliver to (setup failed before the worktree existed), the queued turn
    /// is failed instead of dropped — nothing else would ever terminate it.
    pub fn release_held(&self, workspace_id: &str, cwd: &Path) {
        let _ = self.ensure(workspace_id, cwd);
        let undeliverable = {
            let mut convs = self.inner.convs.lock_safe();
            let Some(conv) = convs.get_mut(workspace_id) else { return };
            let held = conv.held.take();
            match release_for(held.is_some(), conv.engine.is_some()) {
                Release::Deliver => {
                    crate::logf!("chat", "release held prompt ws={workspace_id}");
                    if let (Some(engine), Some(inputs)) = (&conv.engine, held) {
                        engine.send(EngineCommand::Prompt { inputs });
                    }
                    false
                }
                Release::Fail => true,
                Release::Nothing => false,
            }
        };
        if undeliverable {
            crate::logf!("chat", "held prompt undeliverable ws={workspace_id} (no engine) — failing the turn");
            self.inner.finish_turn(
                workspace_id,
                StopKind::Error("The workspace never finished setting up.".into()),
                None,
            );
        }
    }

    /// Push a one-shot system notice into a workspace's transcript, optionally
    /// carrying an action button (e.g. "Delete workspace" when its PR merged).
    /// Get-or-creates the conversation, so it works before the chat was opened.
    pub fn push_notice(
        &self,
        workspace_id: &str,
        cwd: &Path,
        kind: SystemKind,
        text: String,
        action: Option<crate::chat::model::SystemAction>,
    ) -> Result<(), String> {
        self.ensure(workspace_id, cwd)?;
        let conversation_id = {
            let convs = self.inner.convs.lock_safe();
            convs.get(workspace_id).ok_or("no conversation")?.conversation_id.clone()
        };
        let entry = Entry::System(SystemEntry {
            seq: 0,
            entry_id: new_id(),
            kind,
            text,
            created_at: now_ms(),
            steps: Vec::new(),
            action,
        });
        let seq = self.inner.db.lock_safe().insert_entry(&conversation_id, &entry)?;
        events::emit_entry(&self.inner.app, workspace_id, &with_seq(entry, seq));
        Ok(())
    }

    /// Insert the workspace-setup progress card into the transcript. Returns
    /// `(entry_id, seq)` for subsequent in-place updates.
    pub fn begin_setup_card(&self, workspace_id: &str, cwd: &Path, steps: Vec<SetupStep>) -> Result<SetupCard, String> {
        self.ensure(workspace_id, cwd)?; // guarantees the conversation row exists (FK)
        let conversation_id = {
            let convs = self.inner.convs.lock_safe();
            convs.get(workspace_id).ok_or("no conversation")?.conversation_id.clone()
        };
        let card = SetupCard { entry_id: new_id(), seq: 0, created_at: now_ms() };
        let entry = Entry::System(SystemEntry {
            seq: 0,
            entry_id: card.entry_id.clone(),
            kind: SystemKind::Info,
            text: "Setting up workspace".into(),
            created_at: card.created_at,
            steps,
            action: None,
        });
        let seq = self.inner.db.lock_safe().insert_entry(&conversation_id, &entry)?;
        events::emit_entry(&self.inner.app, workspace_id, &with_seq(entry, seq));
        Ok(SetupCard { seq, ..card })
    }

    /// Update the progress card in place: persist the new state and re-emit at
    /// the same seq (the frontend upserts by seq).
    pub fn update_setup_card(
        &self,
        workspace_id: &str,
        card: &SetupCard,
        kind: SystemKind,
        text: String,
        steps: Vec<SetupStep>,
    ) {
        let entry = Entry::System(SystemEntry {
            seq: card.seq,
            entry_id: card.entry_id.clone(),
            kind,
            text,
            created_at: card.created_at,
            steps,
            action: None,
        });
        if let Err(e) = self.inner.db.lock_safe().update_entry(&entry) {
            crate::logf!("setup", "card persist failed ws={workspace_id}: {e}");
        }
        events::emit_entry(&self.inner.app, workspace_id, &entry);
    }
}

/// Handle to the setup progress card for in-place updates.
#[derive(Clone)]
pub struct SetupCard {
    pub entry_id: String,
    pub seq: i64,
    pub created_at: i64,
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
        let entry = Entry::System(SystemEntry {
            seq: 0,
            entry_id: new_id(),
            kind,
            text,
            created_at: now_ms(),
            steps: Vec::new(),
            action: None,
        });
        let seq = { self.db.lock_safe().insert_entry(conversation_id, &entry).unwrap_or(0) };
        events::emit_entry(&self.app, workspace_id, &with_seq(entry, seq));
    }

    /// Drive the session's thought level toward the workspace's preference: a
    /// pre-restart stash (`desired_effort`) wins, else the persisted registry
    /// value. No-ops unless the current model advertises an effort option that
    /// supports the value. Idempotent — the SetConfig it sends comes back as a
    /// `ConfigChanged` whose value then already matches.
    fn apply_desired_effort(&self, ws: &str, conv: &mut ConvState) {
        let target = conv.desired_effort.take().or_else(|| {
            use tauri::Manager as _;
            self.app.state::<crate::project::Registry>().workspace_effort(ws)
        });
        let Some(effort) = target else { return };
        let Some(opt) = conv.config.iter_mut().find(|o| o.category.as_deref() == Some("thoughtLevel")) else {
            return;
        };
        if opt.current_value != effort && opt.choices.iter().any(|c| c.value == effort) {
            crate::logf!("chat", "apply effort ws={ws} id={} value={effort}", opt.id);
            opt.current_value = effort.clone();
            if let Some(engine) = &conv.engine {
                engine.send(EngineCommand::SetConfig { id: opt.id.clone(), value: effort });
            }
        }
    }

    fn handle_event(self: &Arc<Inner>, ws: &str, ev: EngineEvent) {
        match ev {
            EngineEvent::Ready { session_id, config } => {
                let mut convs = self.convs.lock_safe();
                let Some(conv) = convs.get_mut(ws) else { return };
                conv.ready = true;
                conv.config = config;
                // Enforce the desired model over ACP. opencode ACP always starts
                // at its own built-in default (e.g. `opencode/big-pickle`) and
                // ignores the config's top-level `model`, so we set it explicitly.
                // Priority: a model selected before an in-app restart wins, then
                // the workspace's persisted last-selected model (survives app
                // restarts), then the global default model. The response to that
                // SetConfig carries the full refreshed option set (incl. the
                // dynamic `effort` option for variant-capable models) — folded
                // in via `ConfigChanged`, which also re-applies the effort.
                let desired = conv
                    .desired_model
                    .take()
                    .or_else(|| {
                        use tauri::Manager as _;
                        self.app.state::<crate::project::Registry>().workspace_model(ws)
                    })
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
                // If the session's default model already advertises the effort
                // option (no model SetConfig coming), apply the workspace's
                // preferred thinking level now.
                self.apply_desired_effort(ws, conv);
                {
                    let db = self.db.lock_safe();
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
            EngineEvent::Plan(entries) => {
                let todos: Vec<events::Todo> =
                    entries.into_iter().map(|e| events::Todo { content: e.content, status: e.status }).collect();
                let mut convs = self.convs.lock_safe();
                let Some(conv) = convs.get_mut(ws) else { return };
                crate::logf!("chat", "todos from engine plan ws={ws} n={}", todos.len());
                events::emit_todos(&self.app, ws, &todos);
                conv.todos = todos;
            }
            EngineEvent::Commands(list) => {
                let cmds: Vec<events::CommandInfo> = list
                    .into_iter()
                    .map(|c| events::CommandInfo { name: c.name, description: c.description })
                    .collect();
                let mut convs = self.convs.lock_safe();
                let Some(conv) = convs.get_mut(ws) else { return };
                crate::logf!("chat", "commands ws={ws} n={}", cmds.len());
                // Cache on the conversation so a later snapshot (re-open / switch
                // back) carries them even though opencode only pushes them once.
                conv.commands = cmds.clone();
                events::emit_commands(&self.app, ws, &cmds);
            }
            EngineEvent::Context { used, size } => events::emit_context(&self.app, ws, used, size),
            EngineEvent::ConfigAdvertised(config) => {
                let mut convs = self.convs.lock_safe();
                let Some(conv) = convs.get_mut(ws) else { return };
                conv.config = config;
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
            EngineEvent::ConfigChanged(config) => {
                let mut convs = self.convs.lock_safe();
                let Some(conv) = convs.get_mut(ws) else { return };
                conv.config = config;
                // Re-apply the workspace's thinking level: the effort option is
                // dynamic (appears with the model), and a model change resets it
                // to the model's default.
                self.apply_desired_effort(ws, conv);
                events::emit_config(&self.app, ws, &conv.config);
            }
            EngineEvent::TurnEnded { stop, usage } => self.finish_turn(ws, stop, usage),
            EngineEvent::Permission { req, reply } => {
                let mut convs = self.convs.lock_safe();
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
                self.finish_turn(ws, StopKind::Error(e), None);
            }
            EngineEvent::Closed => {
                let mut convs = self.convs.lock_safe();
                if let Some(conv) = convs.get_mut(ws) {
                    conv.engine = None;
                    conv.ready = false;
                }
                drop(convs);
                // If a turn was live when the process died, fail it.
                self.finish_turn(ws, StopKind::Error("engine closed".into()), None);
            }
        }
    }

    fn handle_update(self: &Arc<Inner>, ws: &str, update: RawUpdate) {
        let mut convs = self.convs.lock_safe();
        let Some(conv) = convs.get_mut(ws) else { return };

        // Block-producing updates fold into the live turn via the assembler.
        if conv.current.is_some() {
            if let Some(delta) = conv.assembler.apply(&update) {
                if let Some(cur) = &mut conv.current {
                    let seq = cur.seq;
                    let started = !cur.streaming;
                    cur.streaming = true;
                    // Every block event carries the FULL authoritative block —
                    // the frontend upserts by blockId, so delivery glitches
                    // (a duplicated, reordered, or dropped event) can never
                    // corrupt the rendered text the way incremental appends
                    // could (§thought-doubling). Costs re-sending the growing
                    // string per chunk; localhost IPC absorbs that fine.
                    let full = &conv.assembler.blocks[delta.index];
                    // opencode surfaces the plan/todo list as a `todowrite` tool
                    // call (not an ACP `Plan`), so drive the composer's TodoButton
                    // from the tool's `todos` input (§NOTES).
                    let todos = todos_from_block(full);
                    events::emit_block(&self.app, ws, seq, full);
                    if let Some(todos) = todos {
                        crate::logf!("chat", "todos from tool ws={ws} n={}", todos.len());
                        events::emit_todos(&self.app, ws, &todos);
                        conv.todos = todos;
                    }
                    if started {
                        let origin = cur.origin;
                        let _ = self.turn_tx.send(TurnEvent {
                            workspace_id: ws.to_string(),
                            origin,
                            status: TurnStatus::Streaming,
                        });
                    }
                    // Persist the live blocks continuously (block-level changes
                    // immediately; token appends throttled) so a snapshot taken
                    // mid-turn — switching workspaces, app restart — carries the
                    // in-progress work instead of an empty entry.
                    let block_level = delta.text_append.is_none();
                    let due = cur.last_persist.is_none_or(|t| t.elapsed() >= std::time::Duration::from_millis(400));
                    if block_level || due {
                        cur.last_persist = Some(std::time::Instant::now());
                        let entry = Entry::Assistant(AssistantEntry {
                            seq: cur.seq,
                            entry_id: cur.entry_id.clone(),
                            status: TurnStatus::Streaming,
                            origin: cur.origin,
                            blocks: conv.assembler.blocks.clone(),
                            summary: compute_collapse(&conv.assembler.blocks, true),
                            usage: None, // usage arrives only at turn end
                            started_at: cur.started_at,
                            ended_at: None,
                        });
                        let db = self.db.lock_safe();
                        if let Err(e) = db.update_entry(&entry) {
                            crate::logf!("chat", "streaming flush FAILED ws={ws} seq={}: {e}", cur.seq);
                        }
                    }
                }
            }
        }
    }

    fn finish_turn(self: &Arc<Inner>, ws: &str, stop: StopKind, usage: Option<UsageInfo>) {
        let mut convs = self.convs.lock_safe();
        let Some(conv) = convs.get_mut(ws) else { return };
        let conv_id = conv.conversation_id.clone();
        let Some(closed) = close_turn(conv, &stop, usage.clone(), now_ms()) else { return };
        let seq = closed.entry.seq();
        {
            // The terminal write for this turn — if it fails the transcript
            // keeps the last streamed snapshot instead, so say so out loud.
            let db = self.db.lock_safe();
            if let Err(e) = db.update_entry(&closed.entry) {
                crate::logf!("chat", "terminal turn write FAILED ws={ws} seq={seq}: {e}");
            }
        }
        drop(convs);
        // The full terminal entry FIRST (authoritative blocks — the live view
        // must end exactly equal to what the DB holds), then the turn status.
        events::emit_entry(&self.app, ws, &closed.entry);
        events::emit_turn(&self.app, ws, seq, closed.status, &closed.summary, usage.as_ref(), Some(closed.ended_at));
        if let Some(text) = closed.err_text {
            crate::logf!("chat", "turn failed ws={ws} seq={seq}: {text}");
            self.push_system(ws, &conv_id, SystemKind::Error, format!("Turn failed: {text}"));
        }
        let _ =
            self.turn_tx.send(TurnEvent { workspace_id: ws.to_string(), origin: closed.origin, status: closed.status });
    }
}

/// Where a freshly queued prompt goes. The turn is already visible in the
/// transcript by the time this is decided, so every outcome must end in a
/// terminal status eventually — a silently parked prompt is a stuck spinner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dispatch {
    /// Straight to the live engine.
    Deliver,
    /// Park it; `release_held` delivers it when setup reaches a terminal state.
    Hold,
    /// No engine, and no provisioning pipeline that would ever boot one — only
    /// the SetupManager releases held prompts, so parking this one would leave
    /// the turn Queued invisibly forever. The caller fails the turn instead.
    Orphan,
}

fn dispatch_for(has_engine: bool, provisioning: bool) -> Dispatch {
    match (has_engine, provisioning) {
        // A provisioning workspace holds even when an engine already exists:
        // its cwd may still be mid-checkout.
        (_, true) => Dispatch::Hold,
        (true, false) => Dispatch::Deliver,
        (false, false) => Dispatch::Orphan,
    }
}

/// What [`ChatManager::release_held`] does with the parked prompt once setup
/// reached a terminal state (success *or* failure).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Release {
    Deliver,
    /// Setup failed before the worktree existed, so no engine was ever booted.
    /// Nothing else would terminate the queued turn — fail it rather than drop it.
    Fail,
    /// Nothing was held (the common case: setup finished with no prompt waiting).
    Nothing,
}

fn release_for(has_held: bool, has_engine: bool) -> Release {
    match (has_held, has_engine) {
        (false, _) => Release::Nothing,
        (true, true) => Release::Deliver,
        (true, false) => Release::Fail,
    }
}

/// Stash the user's session choices and tear the engine down for a restart.
/// The stash is what stops the fresh ACP session from snapping the model back
/// to opencode's built-in default (the reasoning-change reset bug). `current`
/// is cleared unconditionally — the caller already finished the live turn with
/// a terminal status, and its `TurnEnded` will never arrive now that the
/// process is gone.
fn reset_for_restart(conv: &mut ConvState, reason: SessionReason) {
    let current_of = |category: &str| {
        conv.config.iter().find(|o| o.category.as_deref() == Some(category)).map(|o| o.current_value.clone())
    };
    conv.desired_model = current_of("model");
    conv.desired_effort = current_of("thoughtLevel");
    conv.engine = None; // Drop → Shutdown + abort the old opencode acp
    conv.ready = false;
    conv.current = None;
    conv.pending_reason = reason;
}

/// The terminal state of a turn that just ended, for the caller to persist,
/// emit, and broadcast.
struct ClosedTurn {
    entry: Entry,
    status: TurnStatus,
    summary: CollapseSummary,
    origin: TurnOrigin,
    ended_at: i64,
    /// Why it failed, surfaced in the transcript (§3.5) so the user sees the
    /// reason instead of a silent stop. `None` unless it failed.
    err_text: Option<String>,
}

/// Take the conversation's live turn and fold it into its terminal entry:
/// status from `stop`, the assembler's accumulated blocks, a collapse summary,
/// and every dangling permission responder resolved (the ACP side must never be
/// left blocked on a turn that ended). `None` when no turn is live — a late or
/// duplicate stop signal is a no-op, which is what makes finishing a turn
/// idempotent across the restart / engine-closed / TurnEnded paths.
fn close_turn(conv: &mut ConvState, stop: &StopKind, usage: Option<UsageInfo>, now: i64) -> Option<ClosedTurn> {
    let cur = conv.current.take()?;
    let (status, err_text) = match stop {
        StopKind::Completed => (TurnStatus::Completed, None),
        StopKind::Cancelled => (TurnStatus::Cancelled, None),
        StopKind::Refusal => (TurnStatus::Failed, Some("The agent declined to continue.".to_string())),
        StopKind::Error(e) => (TurnStatus::Failed, Some(e.clone())),
    };
    let blocks = std::mem::take(&mut conv.assembler).blocks;
    let summary = compute_collapse(&blocks, true);
    let entry = Entry::Assistant(AssistantEntry {
        seq: cur.seq,
        entry_id: cur.entry_id,
        status,
        origin: cur.origin,
        blocks,
        summary: summary.clone(),
        usage,
        started_at: cur.started_at,
        ended_at: Some(now),
    });
    for (_id, tx) in conv.pending_perms.drain() {
        let _ = tx.send(None);
    }
    Some(ClosedTurn { entry, status, summary, origin: cur.origin, ended_at: now, err_text })
}

fn with_seq(mut entry: Entry, seq: Seq) -> Entry {
    entry.set_seq(seq);
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
        })
        .collect();
    Some(todos)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::model::{ConfigChoice, ToolBlock, ToolStatus};

    fn conv() -> ConvState {
        ConvState::new("conv-1".into(), PathBuf::from("/nope/does-not-exist"))
    }

    /// An engine stand-in: a real [`EngineHandle`] whose commands land in the
    /// returned receiver instead of an `opencode acp` process.
    fn fake_engine() -> (EngineHandle, mpsc::UnboundedReceiver<EngineCommand>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (EngineHandle::new(tx, tauri::async_runtime::spawn(async {})), rx)
    }

    fn opt(id: &str, category: &str, value: &str) -> ConfigOption {
        ConfigOption {
            id: id.into(),
            name: id.into(),
            description: None,
            category: Some(category.into()),
            current_value: value.into(),
            choices: vec![ConfigChoice { value: value.into(), name: value.into(), description: None, group: None }],
        }
    }

    fn text(id: &str, s: &str) -> Block {
        Block::Text { block_id: id.into(), text: s.into() }
    }

    /// Put a live turn on the conversation, as `send` does.
    fn start_turn(conv: &mut ConvState) {
        conv.current = Some(LiveTurn {
            entry_id: "entry-a".into(),
            seq: 42,
            origin: TurnOrigin::User,
            started_at: 1_000,
            streaming: true,
            last_persist: None,
        });
    }

    fn assistant(entry: &Entry) -> &AssistantEntry {
        match entry {
            Entry::Assistant(a) => a,
            other => panic!("expected an assistant entry, got {other:?}"),
        }
    }

    // ── send(): where a freshly queued prompt goes ──────────────────────────

    #[test]
    fn a_ready_workspace_delivers_the_prompt_straight_to_the_engine() {
        assert_eq!(dispatch_for(true, false), Dispatch::Deliver);
    }

    #[test]
    fn a_provisioning_workspace_holds_the_prompt() {
        // Held whether or not an engine happens to exist already — the cwd may
        // still be mid-checkout.
        assert_eq!(dispatch_for(false, true), Dispatch::Hold);
        assert_eq!(dispatch_for(true, true), Dispatch::Hold);
    }

    #[test]
    fn no_engine_and_no_setup_pipeline_orphans_the_prompt() {
        // Nothing would ever release a hold here, so the caller fails the turn
        // instead of leaving a Queued row spinning forever.
        assert_eq!(dispatch_for(false, false), Dispatch::Orphan);
    }

    // ── release_held(): setup reached a terminal state ──────────────────────

    #[test]
    fn a_held_prompt_reaches_the_engine_once_setup_succeeds() {
        assert_eq!(release_for(true, true), Release::Deliver);
    }

    #[test]
    fn a_held_prompt_with_no_engine_fails_the_turn_rather_than_dropping_it() {
        // Setup failed before the worktree existed: no engine was ever booted,
        // and nothing else terminates the queued turn.
        assert_eq!(release_for(true, false), Release::Fail);
    }

    #[test]
    fn releasing_with_nothing_held_does_nothing() {
        assert_eq!(release_for(false, true), Release::Nothing);
        assert_eq!(release_for(false, false), Release::Nothing);
    }

    // ── close_turn(): the terminal status of a live turn ────────────────────

    #[test]
    fn a_restart_closes_the_live_turn_as_cancelled() {
        // The Phase 1 fix: without this the reloaded transcript shows a
        // perpetual spinner, because the dropped engine's TurnEnded never comes.
        let mut c = conv();
        start_turn(&mut c);
        c.assembler.blocks = vec![text("b1", "half an answer")];
        let closed = close_turn(&mut c, &StopKind::Cancelled, None, 5_000).expect("a turn was live");
        assert_eq!(closed.status, TurnStatus::Cancelled);
        assert_eq!(closed.err_text, None, "a cancel is not a failure");
        let a = assistant(&closed.entry);
        assert_eq!(a.status, TurnStatus::Cancelled);
        assert_eq!(a.seq, 42);
        assert_eq!(a.entry_id, "entry-a");
        assert_eq!(a.started_at, 1_000);
        assert_eq!(a.ended_at, Some(5_000));
        assert_eq!(a.blocks, vec![text("b1", "half an answer")], "the partial work is kept");
        assert!(a.summary.collapsed);
        assert!(c.current.is_none(), "no live turn survives");
        assert!(c.assembler.blocks.is_empty(), "the assembler is clean for the next turn");
    }

    #[test]
    fn an_engine_that_closes_mid_turn_fails_it_with_the_reason() {
        let mut c = conv();
        start_turn(&mut c);
        let closed = close_turn(&mut c, &StopKind::Error("engine closed".into()), None, 5_000).unwrap();
        assert_eq!(closed.status, TurnStatus::Failed);
        assert_eq!(closed.err_text.as_deref(), Some("engine closed"));
        assert_eq!(assistant(&closed.entry).status, TurnStatus::Failed);
    }

    #[test]
    fn a_refusal_fails_the_turn_with_a_human_reason() {
        let mut c = conv();
        start_turn(&mut c);
        let closed = close_turn(&mut c, &StopKind::Refusal, None, 5_000).unwrap();
        assert_eq!(closed.status, TurnStatus::Failed);
        assert_eq!(closed.err_text.as_deref(), Some("The agent declined to continue."));
    }

    #[test]
    fn a_completed_turn_carries_its_usage_and_no_error() {
        let mut c = conv();
        start_turn(&mut c);
        let usage =
            UsageInfo { input: Some(12), output: Some(34), reasoning: None, cache_read: None, cache_write: None };
        let closed = close_turn(&mut c, &StopKind::Completed, Some(usage.clone()), 5_000).unwrap();
        assert_eq!(closed.status, TurnStatus::Completed);
        assert_eq!(closed.err_text, None);
        assert_eq!(assistant(&closed.entry).usage, Some(usage));
    }

    #[test]
    fn closing_a_turn_twice_is_a_no_op() {
        // What makes the restart / engine-closed / TurnEnded paths safe to
        // race: only the first close produces a terminal entry.
        let mut c = conv();
        start_turn(&mut c);
        assert!(close_turn(&mut c, &StopKind::Cancelled, None, 5_000).is_some());
        assert!(close_turn(&mut c, &StopKind::Completed, None, 6_000).is_none());
    }

    #[test]
    fn closing_a_turn_with_nothing_live_is_a_no_op() {
        let mut c = conv();
        assert!(close_turn(&mut c, &StopKind::Completed, None, 5_000).is_none());
    }

    #[test]
    fn closing_a_turn_unblocks_every_pending_permission() {
        // The ACP responders are awaiting these; leaving one hanging wedges the
        // engine's session task.
        let mut c = conv();
        start_turn(&mut c);
        let (tx1, mut rx1) = oneshot::channel();
        let (tx2, mut rx2) = oneshot::channel();
        c.pending_perms.insert("req-1".into(), tx1);
        c.pending_perms.insert("req-2".into(), tx2);
        close_turn(&mut c, &StopKind::Error("engine closed".into()), None, 5_000).unwrap();
        assert_eq!(rx1.try_recv().unwrap(), None, "rejected, not left hanging");
        assert_eq!(rx2.try_recv().unwrap(), None);
        assert!(c.pending_perms.is_empty());
    }

    #[test]
    fn the_terminal_entry_summarizes_the_work_it_carries() {
        let mut c = conv();
        start_turn(&mut c);
        c.assembler.blocks = vec![text("b1", "done"), tool_block("edit", serde_json::json!({}))];
        let closed = close_turn(&mut c, &StopKind::Completed, None, 5_000).unwrap();
        assert_eq!(closed.summary, assistant(&closed.entry).summary, "one summary, not two");
        assert!(closed.summary.collapsed);
        assert_eq!(closed.summary.step_count, 1, "the tool call is a step");
    }

    // ── reset_for_restart(): tearing the engine down ────────────────────────

    #[test]
    fn a_restart_stashes_the_chosen_model_and_thinking_level() {
        let mut c = conv();
        c.config =
            vec![opt("m", "model", "anthropic/opus"), opt("e", "thoughtLevel", "high"), opt("x", "mode", "build")];
        reset_for_restart(&mut c, SessionReason::Cleared);
        assert_eq!(c.desired_model.as_deref(), Some("anthropic/opus"));
        assert_eq!(c.desired_effort.as_deref(), Some("high"));
        assert_eq!(c.pending_reason, SessionReason::Cleared);
    }

    #[test]
    fn a_restart_before_any_config_arrived_stashes_nothing() {
        let mut c = conv();
        reset_for_restart(&mut c, SessionReason::Compacted);
        assert_eq!(c.desired_model, None);
        assert_eq!(c.desired_effort, None);
    }

    #[test]
    fn a_restart_drops_the_engine_and_the_live_turn() {
        let mut c = conv();
        let (engine, mut rx) = fake_engine();
        c.engine = Some(engine);
        c.ready = true;
        start_turn(&mut c);
        reset_for_restart(&mut c, SessionReason::Cleared);
        assert!(c.engine.is_none());
        assert!(!c.ready);
        assert!(c.current.is_none(), "the caller already closed it as Cancelled");
        // Dropping the handle shuts the old `opencode acp` down.
        assert!(matches!(rx.try_recv(), Ok(EngineCommand::Shutdown)));
    }

    // ── prompt building ─────────────────────────────────────────────────────

    fn attachment(url: &str) -> Attachment {
        Attachment { mime: "image/png".into(), url: url.into(), filename: Some("shot.png".into()) }
    }

    #[test]
    fn images_are_sent_ahead_of_the_text() {
        let inputs = build_inputs("look at this", &[attachment("data:image/png;base64,AAAA")]);
        assert!(matches!(&inputs[0], PromptInput::Image { mime, data } if mime == "image/png" && data == "AAAA"));
        assert!(matches!(&inputs[1], PromptInput::Text(t) if t == "look at this"));
    }

    #[test]
    fn an_empty_message_sends_only_its_attachments() {
        let inputs = build_inputs("", &[attachment("data:image/png;base64,AAAA")]);
        assert_eq!(inputs.len(), 1);
        assert!(matches!(inputs[0], PromptInput::Image { .. }));
    }

    #[test]
    fn an_unparseable_attachment_url_is_skipped_not_sent_as_text() {
        let inputs = build_inputs("hi", &[attachment("https://example.test/shot.png")]);
        assert_eq!(inputs.len(), 1);
        assert!(matches!(&inputs[0], PromptInput::Text(t) if t == "hi"));
    }

    #[test]
    fn data_urls_split_into_mime_and_payload() {
        assert_eq!(parse_data_url("data:image/png;base64,AAAA"), Some(("image/png".into(), "AAAA".into())));
        // No parameters, and a default mime when the meta section is empty.
        assert_eq!(parse_data_url("data:text/plain,hello"), Some(("text/plain".into(), "hello".into())));
        assert_eq!(parse_data_url("data:,hello"), Some(("".into(), "hello".into())));
        assert_eq!(parse_data_url("https://example.test/x.png"), None);
        assert_eq!(parse_data_url("data:image/png;base64"), None, "no comma, no payload");
    }

    // ── todo extraction (opencode's `todowrite` tool call) ──────────────────

    fn tool_block(name: &str, input: serde_json::Value) -> Block {
        Block::Tool(Box::new(ToolBlock {
            block_id: "b-tool".into(),
            call_id: "call-1".into(),
            name: name.into(),
            title: None,
            status: ToolStatus::Completed,
            input,
            output: None,
            diff: None,
            locations: vec![],
            raw_output: None,
            started_at: None,
            ended_at: None,
        }))
    }

    #[test]
    fn a_todowrite_tool_call_yields_the_composers_todo_list() {
        // Keyed on the input shape, not the tool name — ACP reports it as
        // ToolKind::Other with an engine-chosen title.
        let block = tool_block(
            "some-engine-title",
            serde_json::json!({
                "todos": [
                    { "content": "write the test", "status": "completed" },
                    { "content": "ship it", "status": "in_progress" },
                ]
            }),
        );
        let todos = todos_from_block(&block).expect("a todo list");
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].content, "write the test");
        assert_eq!(todos[1].status, "in_progress");
    }

    #[test]
    fn a_malformed_todo_entry_defaults_to_pending_rather_than_dropping_out() {
        let block = tool_block("todowrite", serde_json::json!({ "todos": [{ "content": "x" }, {}] }));
        let todos = todos_from_block(&block).unwrap();
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].status, "pending");
        assert_eq!(todos[1].content, "");
    }

    #[test]
    fn other_blocks_yield_no_todos() {
        assert!(todos_from_block(&text("b1", "hello")).is_none());
        assert!(todos_from_block(&tool_block("bash", serde_json::json!({ "command": "ls" }))).is_none());
        assert!(todos_from_block(&tool_block("weird", serde_json::json!({ "todos": "not-an-array" }))).is_none());
    }
}
