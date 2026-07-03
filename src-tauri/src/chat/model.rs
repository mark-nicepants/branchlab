//! The normalized chat domain model.
//!
//! These types are BranchLab's own shapes — deliberately decoupled from both the
//! OpenCode HTTP API and the raw ACP wire protocol. They are the single schema
//! shared by the SQLite store, the delta events, and the frontend (`types.ts`
//! mirrors them, camelCase). Engine-specific data is mapped into this model in
//! `crate::chat::assembler`; nothing downstream sees ACP or OpenCode shapes.

use serde::{Deserialize, Serialize};

/// Monotonic per-store ordering key (the `entries` rowid). Doubles as the
/// pagination cursor: entries render ascending by `seq`, history pages backward.
pub type Seq = i64;

/// A BranchLab conversation — one per workspace today, but able to span many
/// engine sessions over its life (compact/clear/reload each start a new one
/// while the timeline continues unbroken).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    /// Stable ULID (never the engine's session id).
    pub id: String,
    pub workspace_id: String,
    pub title: Option<String>,
    pub created_at: i64,
    /// The engine (ACP) session id currently driving new turns, if any.
    pub active_engine_session: Option<String>,
}

/// Why a new engine session was opened under a conversation. The timeline keeps
/// all prior entries regardless — the reason is metadata for the UI divider.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionReason {
    /// The conversation's first session.
    Started,
    /// Context was compacted; a fresh engine session continues the thread.
    Compacted,
    /// The user cleared context; a fresh engine session, history retained.
    Cleared,
    /// Reconnected after a restart / engine reap.
    Reloaded,
}

/// One engine session under a conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineSession {
    pub id: i64,
    pub conversation_id: String,
    pub acp_session_id: String,
    pub engine: String,
    pub reason: SessionReason,
    pub started_at: i64,
    pub active: bool,
}

/// Who caused a turn. The supervisor keys its autofix hand-off on this so a
/// background fix turn is never confused with the user chatting.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TurnOrigin {
    User,
    Slash,
    Lifecycle,
    Init,
    Autofix,
}

/// The turn lifecycle. `Queued -> Streaming -> (AwaitingPermission <-> Streaming)
/// -> terminal`. Terminal states trigger structural collapse.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    /// Prompt dispatched; no engine update seen yet.
    Queued,
    /// Actively producing content / running tools.
    Streaming,
    /// Blocked on a permission (ACP `session/request_permission`).
    AwaitingPermission,
    /// Finished normally (`stopReason` end_turn / max_tokens / etc.).
    Completed,
    /// Aborted by the user or `stopReason` cancelled.
    Cancelled,
    /// Transport/session error, or interrupted by a restart.
    Failed,
}

impl TurnStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, TurnStatus::Completed | TurnStatus::Cancelled | TurnStatus::Failed)
    }

    pub fn is_active(self) -> bool {
        !self.is_terminal()
    }

    /// Whether a transition is legal. The manager relies on this to ignore
    /// stray/late engine events after a turn has already finished (R-order).
    pub fn can_transition_to(self, next: TurnStatus) -> bool {
        use TurnStatus::*;
        if self.is_terminal() {
            return false; // terminal is final
        }
        match (self, next) {
            (Queued, Streaming | AwaitingPermission) => true,
            (Streaming, AwaitingPermission) => true,
            (AwaitingPermission, Streaming) => true,
            // Any active state may go straight to any terminal state.
            (_, Completed | Cancelled | Failed) => true,
            _ => false,
        }
    }
}

/// A pasted/attached file on a user message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub mime: String,
    /// Data URL or file URL, as sent to the engine.
    pub url: String,
    pub filename: Option<String>,
}

/// Context-window / cost usage reported by the engine for an assistant turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub reasoning: Option<u64>,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
}

/// A tool call's runtime status, mapped from ACP tool-call statuses.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

/// A file edit rendered by the diff viewer. Carries the raw old/new text (fed to
/// the frontend `synthesizeDiff`) and/or a ready-made unified diff.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffBlock {
    pub path: String,
    pub old_text: Option<String>,
    pub new_text: String,
    pub unified: Option<String>,
}

/// A tool-call block within an assistant turn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolBlock {
    pub block_id: String,
    /// ACP toolCallId — the stable upsert key across ToolCall/ToolCallUpdate.
    pub call_id: String,
    /// Normalized tool name (e.g. "edit", "bash", "read").
    pub name: String,
    pub title: Option<String>,
    pub status: ToolStatus,
    pub input: serde_json::Value,
    pub output: Option<String>,
    pub diff: Option<DiffBlock>,
    pub error: Option<String>,
}

/// One rendered unit inside an assistant turn. `type` discriminates on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Block {
    Text { block_id: String, text: String },
    Reasoning { block_id: String, text: String },
    // Boxed: ToolBlock is much larger than the other variants (clippy
    // large_enum_variant). Box<T> serializes transparently, so the wire/JSON
    // shape the frontend sees is unchanged.
    Tool(Box<ToolBlock>),
    File { block_id: String, name: Option<String>, mime: Option<String>, url: String },
}

impl Block {
    /// The stable id used to upsert this block during streaming.
    pub fn block_id(&self) -> &str {
        match self {
            Block::Text { block_id, .. } => block_id,
            Block::Reasoning { block_id, .. } => block_id,
            Block::Tool(t) => &t.block_id,
            Block::File { block_id, .. } => block_id,
        }
    }
}

/// Deterministic, zero-token "what the AI did" summary for a finished turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollapseSummary {
    /// True once the turn is terminal — the UI collapses the work under `headline`.
    pub collapsed: bool,
    /// Count of reasoning + tool blocks (the "steps").
    pub step_count: u32,
    /// Distinct files touched by edit/write tools.
    pub files_edited: Vec<String>,
    /// Count of bash/command tool calls.
    pub commands_run: u32,
    /// One-line headline, e.g. "Edited 3 files · ran 5 commands".
    pub headline: String,
}

/// Severity of a system entry (lifecycle notice, init notice, error).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SystemKind {
    Info,
    Success,
    Error,
}

/// A user message. `display` is what the UI shows; `sent` is what actually went
/// to the engine — the two differ for slash expansion, lifecycle prompts, the
/// init prompt, and skill injection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserEntry {
    pub seq: Seq,
    pub entry_id: String,
    pub display: String,
    pub sent: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    pub model: Option<String>,
    pub variant: Option<String>,
    pub agent: Option<String>,
    pub origin: TurnOrigin,
    pub created_at: i64,
}

/// An assistant turn — the collapsible unit of AI work.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssistantEntry {
    pub seq: Seq,
    pub entry_id: String,
    pub engine_session_id: Option<i64>,
    pub status: TurnStatus,
    pub origin: TurnOrigin,
    pub blocks: Vec<Block>,
    pub summary: CollapseSummary,
    pub usage: Option<Usage>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

/// A local, UI-only notice (lifecycle progress/result, init notice). Never sent
/// to or received from the model. Replaces the old frontend `SystemMessage`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemEntry {
    pub seq: Seq,
    pub entry_id: String,
    pub kind: SystemKind,
    pub text: String,
    pub created_at: i64,
}

/// A selectable choice within a config option (a model, a reasoning level, …).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigChoice {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
    /// Optional group label (ACP grouped selects), for section headers.
    pub group: Option<String>,
}

/// A session config option flattened for the UI — drives the model / reasoning /
/// mode selectors from one mechanism (ACP Session Config Options). `category`
/// tells the frontend which selector it belongs to ("model", "thoughtLevel",
/// "mode", …).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub current_value: String,
    pub choices: Vec<ConfigChoice>,
}

/// One item in a conversation's timeline. `type` discriminates on the wire so
/// the frontend can switch on `entry.type`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Entry {
    User(UserEntry),
    Assistant(AssistantEntry),
    System(SystemEntry),
}

impl Entry {
    pub fn seq(&self) -> Seq {
        match self {
            Entry::User(e) => e.seq,
            Entry::Assistant(e) => e.seq,
            Entry::System(e) => e.seq,
        }
    }

    pub fn entry_id(&self) -> &str {
        match self {
            Entry::User(e) => &e.entry_id,
            Entry::Assistant(e) => &e.entry_id,
            Entry::System(e) => &e.entry_id,
        }
    }
}

/// Extract the file path a tool edit/write acted on, for the collapse summary.
/// Prefers the diff's path, then common input field names.
fn tool_file_path(t: &ToolBlock) -> Option<String> {
    if let Some(d) = &t.diff {
        return Some(d.path.clone());
    }
    for key in ["file", "path", "filePath", "file_path"] {
        if let Some(v) = t.input.get(key).and_then(|v| v.as_str()) {
            return Some(v.to_string());
        }
    }
    None
}

/// Whether a tool name denotes a file edit for collapse accounting.
fn is_edit_tool(name: &str) -> bool {
    matches!(name, "edit" | "write" | "patch" | "multiedit")
}

/// Whether a tool name denotes a shell command for collapse accounting.
fn is_command_tool(name: &str) -> bool {
    matches!(name, "bash" | "shell" | "run" | "execute")
}

/// Build the human headline from the collapse counts.
fn build_headline(files: usize, commands: u32, steps: u32) -> String {
    let mut parts: Vec<String> = Vec::new();
    if files > 0 {
        parts.push(format!("Edited {} file{}", files, if files == 1 { "" } else { "s" }));
    }
    if commands > 0 {
        parts.push(format!("ran {} command{}", commands, if commands == 1 { "" } else { "s" }));
    }
    if parts.is_empty() {
        // No file/command work — describe by step count instead.
        return match steps {
            0 => "Responded".to_string(),
            1 => "Worked 1 step".to_string(),
            n => format!("Worked {n} steps"),
        };
    }
    // Capitalize the first part only; join the rest lowercase with a middle dot.
    parts.join(" · ")
}

/// Compute the structural-collapse summary from a turn's blocks. Deterministic
/// and free — this is "summarize when the AI is done" without an LLM.
pub fn compute_collapse(blocks: &[Block], collapsed: bool) -> CollapseSummary {
    let mut step_count = 0u32;
    let mut files_edited: Vec<String> = Vec::new();
    let mut commands_run = 0u32;
    for b in blocks {
        match b {
            Block::Reasoning { .. } => step_count += 1,
            Block::Tool(t) => {
                step_count += 1;
                if is_edit_tool(&t.name) {
                    if let Some(p) = tool_file_path(t) {
                        if !files_edited.contains(&p) {
                            files_edited.push(p);
                        }
                    }
                } else if is_command_tool(&t.name) {
                    commands_run += 1;
                }
            }
            _ => {}
        }
    }
    let headline = build_headline(files_edited.len(), commands_run, step_count);
    CollapseSummary { collapsed, step_count, files_edited, commands_run, headline }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(name: &str, input: serde_json::Value, diff: Option<DiffBlock>) -> Block {
        Block::Tool(Box::new(ToolBlock {
            block_id: format!("b-{name}"),
            call_id: format!("c-{name}"),
            name: name.to_string(),
            title: None,
            status: ToolStatus::Completed,
            input,
            output: None,
            diff,
            error: None,
        }))
    }

    #[test]
    fn turn_status_terminal_and_active() {
        assert!(TurnStatus::Completed.is_terminal());
        assert!(TurnStatus::Cancelled.is_terminal());
        assert!(TurnStatus::Failed.is_terminal());
        assert!(TurnStatus::Queued.is_active());
        assert!(TurnStatus::Streaming.is_active());
        assert!(TurnStatus::AwaitingPermission.is_active());
    }

    #[test]
    fn turn_transitions_follow_the_machine() {
        use TurnStatus::*;
        assert!(Queued.can_transition_to(Streaming));
        assert!(Streaming.can_transition_to(AwaitingPermission));
        assert!(AwaitingPermission.can_transition_to(Streaming));
        assert!(Streaming.can_transition_to(Completed));
        assert!(AwaitingPermission.can_transition_to(Cancelled));
        // Terminal is final — no resurrection from a late engine event.
        assert!(!Completed.can_transition_to(Streaming));
        assert!(!Failed.can_transition_to(Completed));
        // Illegal skips.
        assert!(!Queued.can_transition_to(Queued));
    }

    #[test]
    fn collapse_counts_files_commands_and_steps() {
        let blocks = vec![
            Block::Reasoning { block_id: "r1".into(), text: "thinking".into() },
            tool("read", json!({ "file": "a.rs" }), None),
            tool("edit", json!({ "file": "a.rs" }), None),
            tool("edit", json!({ "file": "b.rs" }), None),
            // duplicate file must not double-count
            tool("write", json!({ "path": "b.rs" }), None),
            tool("bash", json!({ "command": "cargo test" }), None),
            Block::Text { block_id: "t1".into(), text: "done".into() },
        ];
        let s = compute_collapse(&blocks, true);
        assert!(s.collapsed);
        // reasoning + 5 tools = 6 steps
        assert_eq!(s.step_count, 6);
        assert_eq!(s.files_edited, vec!["a.rs".to_string(), "b.rs".to_string()]);
        assert_eq!(s.commands_run, 1);
        assert_eq!(s.headline, "Edited 2 files · ran 1 command");
    }

    #[test]
    fn collapse_prefers_diff_path() {
        let diff = DiffBlock { path: "from/diff.rs".into(), old_text: None, new_text: "x".into(), unified: None };
        let blocks = vec![tool("edit", json!({ "file": "from/input.rs" }), Some(diff))];
        let s = compute_collapse(&blocks, true);
        assert_eq!(s.files_edited, vec!["from/diff.rs".to_string()]);
    }

    #[test]
    fn collapse_headline_without_files_uses_steps() {
        let blocks = vec![
            Block::Reasoning { block_id: "r1".into(), text: "a".into() },
            Block::Reasoning { block_id: "r2".into(), text: "b".into() },
        ];
        let s = compute_collapse(&blocks, true);
        assert_eq!(s.headline, "Worked 2 steps");
        assert!(s.files_edited.is_empty());
        assert_eq!(s.commands_run, 0);
    }

    #[test]
    fn entry_tag_serializes_as_type() {
        let e = Entry::System(SystemEntry {
            seq: 1,
            entry_id: "e1".into(),
            kind: SystemKind::Success,
            text: "Committed changes.".into(),
            created_at: 0,
        });
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["type"], "system");
        assert_eq!(v["kind"], "success");
        assert_eq!(v["text"], "Committed changes.");
    }

    #[test]
    fn block_tool_tag_and_roundtrip() {
        let b = tool("edit", json!({ "file": "a.rs" }), None);
        let v = serde_json::to_value(&b).unwrap();
        assert_eq!(v["type"], "tool");
        assert_eq!(v["name"], "edit");
        assert_eq!(v["status"], "completed");
        let back: Block = serde_json::from_value(v).unwrap();
        assert_eq!(back, b);
        assert_eq!(back.block_id(), "b-edit");
    }
}
