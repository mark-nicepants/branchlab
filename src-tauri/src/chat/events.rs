//! Backend → frontend chat deltas (Tauri events).
//!
//! Every payload is camelCase and mirrored in `src/lib/types.ts`; the frontend
//! subscribes only through `src/lib/events.ts`. Emitted from the manager's event
//! loop as the normalized model changes. `workspace:session` / `workspace:notify`
//! are NOT here — the supervisor owns those, sourced from the manager's
//! `TurnEvent` broadcast.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::chat::model::{Block, CollapseSummary, ConfigOption, Entry, TurnStatus, UsageInfo};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntryEvent<'a> {
    pub(crate) workspace_id: &'a str,
    pub(crate) entry: &'a Entry,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BlockEvent<'a> {
    pub(crate) workspace_id: &'a str,
    pub(crate) entry_seq: i64,
    pub(crate) block: &'a Block,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnEventPayload<'a> {
    pub(crate) workspace_id: &'a str,
    pub(crate) entry_seq: i64,
    pub(crate) status: TurnStatus,
    pub(crate) summary: &'a CollapseSummary,
    /// Per-turn token usage, set on terminal status when the engine reported
    /// it — drives the live usage footer without a snapshot reload.
    pub(crate) usage: Option<&'a UsageInfo>,
    /// Set when the turn reached a terminal status — drives the live duration
    /// footer without waiting for a snapshot reload.
    pub(crate) ended_at: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PermChoiceDto {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionEvent<'a> {
    pub(crate) workspace_id: &'a str,
    pub(crate) entry_seq: i64,
    pub(crate) request_id: &'a str,
    pub(crate) tool_call_id: &'a str,
    pub(crate) title: Option<&'a str>,
    pub(crate) options: &'a [PermChoiceDto],
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigEvent<'a> {
    pub(crate) workspace_id: &'a str,
    pub(crate) options: &'a [ConfigOption],
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResetEvent<'a> {
    pub(crate) workspace_id: &'a str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextEvent<'a> {
    pub(crate) workspace_id: &'a str,
    pub(crate) used: u64,
    pub(crate) max: u64,
}

/// One slash command advertised by the agent (ACP `AvailableCommandsUpdate`).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    pub name: String,
    pub description: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandsEvent<'a> {
    pub(crate) workspace_id: &'a str,
    pub(crate) commands: &'a [CommandInfo],
}

/// One todo item (from the `todowrite` tool / ACP `Plan`), mirroring the
/// frontend `Todo` exactly — the UI never read `priority`, so it isn't sent.
#[derive(Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub content: String,
    pub status: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TodosEvent<'a> {
    pub(crate) workspace_id: &'a str,
    pub(crate) todos: &'a [Todo],
}

pub fn emit_entry(app: &AppHandle, workspace_id: &str, entry: &Entry) {
    let _ = app.emit("chat:entry", EntryEvent { workspace_id, entry });
}

pub fn emit_block(app: &AppHandle, workspace_id: &str, entry_seq: i64, block: &Block) {
    let _ = app.emit("chat:block", BlockEvent { workspace_id, entry_seq, block });
}

pub fn emit_turn(
    app: &AppHandle,
    workspace_id: &str,
    entry_seq: i64,
    status: TurnStatus,
    summary: &CollapseSummary,
    usage: Option<&UsageInfo>,
    ended_at: Option<i64>,
) {
    let _ = app.emit("chat:turn", TurnEventPayload { workspace_id, entry_seq, status, summary, usage, ended_at });
}

#[allow(clippy::too_many_arguments)]
pub fn emit_permission(
    app: &AppHandle,
    workspace_id: &str,
    entry_seq: i64,
    request_id: &str,
    tool_call_id: &str,
    title: Option<&str>,
    options: &[PermChoiceDto],
) {
    let _ = app
        .emit("chat:permission", PermissionEvent { workspace_id, entry_seq, request_id, tool_call_id, title, options });
}

pub fn emit_config(app: &AppHandle, workspace_id: &str, options: &[ConfigOption]) {
    let _ = app.emit("chat:config", ConfigEvent { workspace_id, options });
}

pub fn emit_reset(app: &AppHandle, workspace_id: &str) {
    let _ = app.emit("chat:reset", ResetEvent { workspace_id });
}

pub fn emit_context(app: &AppHandle, workspace_id: &str, used: u64, max: u64) {
    let _ = app.emit("chat:context", ContextEvent { workspace_id, used, max });
}

pub fn emit_commands(app: &AppHandle, workspace_id: &str, commands: &[CommandInfo]) {
    let _ = app.emit("chat:commands", CommandsEvent { workspace_id, commands });
}

pub fn emit_todos(app: &AppHandle, workspace_id: &str, todos: &[Todo]) {
    let _ = app.emit("workspace:todos", TodosEvent { workspace_id, todos });
}
