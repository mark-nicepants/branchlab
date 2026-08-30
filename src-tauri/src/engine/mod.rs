//! The engine boundary — BranchLab's abstraction over a coding agent.
//!
//! **Every `agent-client-protocol` type in this crate lives under `engine/`**
//! (`acp.rs` drives the protocol, `assembler.rs` folds block updates into the
//! domain model) — `grep -r agent_client_protocol src | grep -v ^src/engine/`
//! must stay empty. The manager talks to an engine through [`EngineCommand`]
//! (outbound) and [`EngineEvent`] (inbound), all BranchLab types.
//!
//! One deliberate seam: block-producing updates ride opaquely as
//! [`assembler::RawUpdate`] in [`EngineEvent::Update`], because the
//! [`assembler::TurnAssembler`] that folds them holds the live turn's blocks
//! and so is owned by the manager alongside the rest of that turn's state. The
//! manager passes the value straight back into the assembler and never
//! inspects it. Every other update kind the engine pre-digests (plan,
//! commands, usage, config). A non-ACP engine could be added by producing the
//! same `EngineEvent` stream.

pub mod acp;
pub mod assembler;
pub mod opencode_http;

use tokio::sync::{mpsc, oneshot};

use crate::chat::model::{ConfigOption, UsageInfo};

/// One piece of a user prompt sent to the engine.
#[derive(Debug, Clone)]
pub enum PromptInput {
    Text(String),
    /// Base64 image data (no `data:` prefix) + mime.
    Image {
        mime: String,
        data: String,
    },
}

/// A command from the manager to a running engine.
pub enum EngineCommand {
    Prompt {
        inputs: Vec<PromptInput>,
    },
    SetConfig {
        id: String,
        value: String,
    },
    /// Generate session metadata from `text` using a throwaway session on the
    /// SAME connection (no extra process, no main-transcript pollution).
    /// Replies with the title + suggested branch, or None on failure.
    GenerateTitle {
        text: String,
        reply: oneshot::Sender<Option<GeneratedTitle>>,
    },
    /// Propose BranchLab setup/teardown scripts from a pre-collected repo
    /// context (manifests, README, file list) — same throwaway-session
    /// mechanics as GenerateTitle. Replies with None on failure.
    GenerateSetup {
        context: String,
        reply: oneshot::Sender<Option<GeneratedSetup>>,
    },
    /// One raw prompt → collected reply text on a throwaway session (same
    /// mechanics as GenerateTitle). The caller owns prompt building and
    /// response parsing. Replies with None on failure.
    OneShot {
        prompt: String,
        reply: oneshot::Sender<Option<String>>,
    },
    Cancel,
    Shutdown,
}

/// AI-generated session metadata from the first message: a display title and
/// a conventional git branch name (e.g. `feature/dark-mode-toggle`), produced
/// by one prompt so titling costs a single model round-trip.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GeneratedTitle {
    pub title: String,
    /// Suggested branch; None when the model didn't produce a usable one.
    pub branch: Option<String>,
}

/// AI-proposed workspace lifecycle scripts (Project settings → Scripts →
/// "Generate with AI"). Filled into the form for user review — never saved
/// directly.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GeneratedSetup {
    pub setup_script: Option<String>,
    pub teardown_script: Option<String>,
    /// One-sentence rationale shown under the filled-in fields.
    pub notes: Option<String>,
}

/// Why a prompt turn ended.
#[derive(Debug, Clone)]
pub enum StopKind {
    Completed,
    Cancelled,
    Refusal,
    Error(String),
}

/// A permission choice offered to the user (mapped from ACP `PermissionOption`).
#[derive(Debug, Clone)]
pub struct PermChoice {
    pub option_id: String,
    pub name: String,
    /// "allowOnce" | "allowAlways" | "rejectOnce" | "rejectAlways".
    pub kind: String,
}

/// A permission request surfaced to the UI. `request_id` is minted by the engine
/// to correlate the user's answer back to the awaiting ACP responder.
#[derive(Debug, Clone)]
pub struct PermissionReq {
    pub request_id: String,
    pub tool_call_id: String,
    pub title: Option<String>,
    pub options: Vec<PermChoice>,
}

/// One entry of the agent's plan. `status` is the wire string the frontend
/// expects: "pending" | "in_progress" | "completed".
#[derive(Debug, Clone)]
pub struct PlanItem {
    pub content: String,
    pub status: String,
}

/// A slash command / skill the agent advertises.
#[derive(Debug, Clone)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
}

/// An event from a running engine to the manager. Tagged with the workspace id
/// by the manager's fan-in channel.
pub enum EngineEvent {
    /// Session initialized; carries the ACP session id and advertised config options.
    Ready { session_id: String, config: Vec<ConfigOption> },
    /// A block-producing session update (message/thought chunks, tool calls),
    /// opaque to the manager: it goes straight into [`assembler::TurnAssembler`].
    /// Every other update kind is pre-digested into the variants below.
    Update(Box<assembler::RawUpdate>),
    /// The agent's plan/todo list (ACP `Plan`).
    Plan(Vec<PlanItem>),
    /// Slash commands / skills the agent advertises (ACP `AvailableCommandsUpdate`).
    Commands(Vec<SlashCommand>),
    /// Context-window usage pushed mid-session (ACP `UsageUpdate`): tokens used
    /// out of the window size.
    Context { used: u64, size: u64 },
    /// Config options the agent pushed unprompted (ACP `ConfigOptionUpdate`),
    /// e.g. after the user switched mode inside the agent.
    ConfigAdvertised(Vec<ConfigOption>),
    /// The refreshed full config-option set returned by a `set_config_option`
    /// call. opencode does NOT emit a `config_option_update` notification for
    /// its own response — the new options (e.g. the dynamic `effort` /
    /// thought-level option that appears when a variant-capable model is
    /// selected) ride only on the response, so the engine forwards them here.
    ConfigChanged(Vec<ConfigOption>),
    /// The current prompt turn finished. `usage` carries the engine-reported
    /// per-turn token counts when available (ACP's unstable end-of-turn usage).
    TurnEnded { stop: StopKind, usage: Option<UsageInfo> },
    /// The agent is asking permission; `reply` resolves with the chosen option id
    /// (or `None` to cancel/reject).
    Permission { req: PermissionReq, reply: oneshot::Sender<Option<String>> },
    /// A fatal engine/transport error (the connection is going away).
    Error(String),
    /// The connection closed.
    Closed,
}

/// Handle to a running engine. Dropping it shuts the engine down.
pub struct EngineHandle {
    cmd_tx: mpsc::UnboundedSender<EngineCommand>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl EngineHandle {
    pub fn send(&self, cmd: EngineCommand) {
        let _ = self.cmd_tx.send(cmd);
    }

    pub(crate) fn new(
        cmd_tx: mpsc::UnboundedSender<EngineCommand>,
        task: tauri::async_runtime::JoinHandle<()>,
    ) -> Self {
        Self { cmd_tx, task }
    }
}

impl Drop for EngineHandle {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(EngineCommand::Shutdown);
        self.task.abort();
    }
}
