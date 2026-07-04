//! The engine boundary — BranchLab's abstraction over a coding agent.
//!
//! The manager talks to an engine only through [`EngineCommand`] (outbound) and
//! [`EngineEvent`] (inbound), never in ACP terms. The one concession: block-level
//! updates are forwarded as the raw ACP `SessionUpdate` (in [`EngineEvent::Update`])
//! because the per-turn assembler that folds them lives in the manager alongside
//! turn state. Everything else the engine pre-digests. A non-ACP engine could be
//! added by producing the same `EngineEvent` stream.

// TODO(chat-rebuild): drop once the manager/commands are fully wired.
#![allow(dead_code)]

pub mod acp;
pub mod opencode_http;

use agent_client_protocol::schema::v1 as acp_schema;
use tokio::sync::{mpsc, oneshot};

use crate::chat::model::ConfigOption;

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
        entry_id: String,
        inputs: Vec<PromptInput>,
    },
    SetConfig {
        id: String,
        value: String,
    },
    /// Generate a short title from `text` using a throwaway session on the SAME
    /// connection (no extra process, no main-transcript pollution). Replies with
    /// the title, or None on failure.
    GenerateTitle {
        text: String,
        reply: oneshot::Sender<Option<String>>,
    },
    Cancel,
    Shutdown,
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

/// An event from a running engine to the manager. Tagged with the workspace id
/// by the manager's fan-in channel.
pub enum EngineEvent {
    /// Session initialized; carries the ACP session id and advertised config options.
    Ready { session_id: String, config: Vec<ConfigOption> },
    /// A streaming session update (blocks, plan, config, title, usage, commands).
    Update(Box<acp_schema::SessionUpdate>),
    /// The refreshed full config-option set returned by a `set_config_option`
    /// call. opencode does NOT emit a `config_option_update` notification for
    /// its own response — the new options (e.g. the dynamic `effort` /
    /// thought-level option that appears when a variant-capable model is
    /// selected) ride only on the response, so the engine forwards them here.
    ConfigChanged(Vec<ConfigOption>),
    /// The current prompt turn finished.
    TurnEnded { stop: StopKind },
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
