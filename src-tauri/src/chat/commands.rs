//! Tauri command surface for the chat subsystem (the IPC the frontend calls).
//! Thin wrappers over `ChatManager`; wrapped again in `src/lib/api.ts`.

use std::path::PathBuf;

use tauri::State;

use crate::chat::manager::{ChatManager, ChatSnapshot};
use crate::chat::model::{Attachment, SessionReason, TurnOrigin};
use crate::project::Registry;

/// Default page size for the initial snapshot / history pages.
const PAGE: i64 = 50;

fn workspace_cwd(registry: &Registry, workspace_id: &str) -> Result<PathBuf, String> {
    registry.workspace_path(workspace_id).map(PathBuf::from).ok_or_else(|| "unknown workspace".to_string())
}

fn parse_origin(origin: Option<String>) -> TurnOrigin {
    match origin.as_deref() {
        Some("slash") => TurnOrigin::Slash,
        Some("lifecycle") => TurnOrigin::Lifecycle,
        Some("init") => TurnOrigin::Init,
        Some("autofix") => TurnOrigin::Autofix,
        _ => TurnOrigin::User,
    }
}

/// Ensure the conversation + engine exist and return the initial snapshot
/// (newest page of entries + advertised config options).
#[tauri::command]
pub fn chat_open(
    workspace_id: String,
    registry: State<Registry>,
    chat: State<ChatManager>,
) -> Result<ChatSnapshot, String> {
    let cwd = workspace_cwd(&registry, &workspace_id)?;
    chat.open(&workspace_id, &cwd, PAGE)
}

/// Fetch a page of older history before `before_seq`.
#[tauri::command]
pub fn chat_history(workspace_id: String, before_seq: i64, chat: State<ChatManager>) -> Result<ChatSnapshot, String> {
    chat.snapshot(&workspace_id, Some(before_seq), PAGE)
}

/// Send a user message. `display` is shown in the UI; `sent` is what the AI
/// receives (they differ for slash/lifecycle/init/skill injection).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn chat_send(
    workspace_id: String,
    display: String,
    sent: String,
    attachments: Option<Vec<Attachment>>,
    origin: Option<String>,
    model: Option<String>,
    variant: Option<String>,
    agent: Option<String>,
    registry: State<Registry>,
    chat: State<ChatManager>,
) -> Result<(), String> {
    let cwd = workspace_cwd(&registry, &workspace_id)?;
    chat.send(
        &workspace_id,
        &cwd,
        display,
        sent,
        attachments.unwrap_or_default(),
        parse_origin(origin),
        model,
        variant,
        agent,
    )
}

/// Generate an AI title + conventional branch name for a workspace from the
/// first message (one prompt on a throwaway session over the same ACP
/// connection). Returns None on failure.
#[tauri::command]
pub async fn chat_generate_title(
    workspace_id: String,
    text: String,
    registry: State<'_, Registry>,
    chat: State<'_, ChatManager>,
) -> Result<Option<crate::engine::GeneratedTitle>, String> {
    let cwd = workspace_cwd(&registry, &workspace_id)?;
    Ok(chat.generate_title(&workspace_id, &cwd, text).await)
}

#[tauri::command]
pub fn chat_abort(workspace_id: String, chat: State<ChatManager>) {
    chat.abort(&workspace_id);
}

/// Change a session config option (model / reasoning / mode) by id + value.
#[tauri::command]
pub fn chat_set_config(workspace_id: String, id: String, value: String, chat: State<ChatManager>) {
    chat.set_config(&workspace_id, id, value);
}

/// Answer a pending permission request. `option_id` = None cancels/rejects.
#[tauri::command]
pub fn chat_answer_permission(
    workspace_id: String,
    request_id: String,
    option_id: Option<String>,
    chat: State<ChatManager>,
) {
    chat.answer_permission(&workspace_id, &request_id, option_id);
}

/// Start a fresh engine session (compact / clear) keeping all prior entries.
#[tauri::command]
pub fn chat_new_session(
    workspace_id: String,
    reason: Option<String>,
    registry: State<Registry>,
    chat: State<ChatManager>,
) -> Result<(), String> {
    let cwd = workspace_cwd(&registry, &workspace_id)?;
    let reason = match reason.as_deref() {
        Some("compacted") => SessionReason::Compacted,
        _ => SessionReason::Cleared,
    };
    chat.new_session(&workspace_id, &cwd, reason)
}
