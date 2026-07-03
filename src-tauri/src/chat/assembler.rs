//! Maps ACP `session/update` notifications into our normalized block model.
//!
//! This is the transform layer — the one place that understands ACP shapes.
//! Everything downstream (store, events, frontend) sees only `crate::chat::model`
//! types. The assembler holds one live assistant turn's blocks in memory and
//! upserts them as chunks/tool updates stream in; the manager reads the changed
//! block out and emits a `chat:block` delta, then persists.
//!
//! Text/reasoning chunks are coalesced by `messageId` (a change in `messageId`
//! starts a new block, per ACP), so streamed prose accumulates into one block
//! instead of one-block-per-token.

use std::collections::HashMap;

use agent_client_protocol::schema::v1 as acp;

use crate::chat::model::{Block, ConfigChoice, ConfigOption, DiffBlock, ToolBlock, ToolStatus};

/// What changed in the block list after applying one update. The manager reads
/// `blocks[index]` for the current state and emits a `chat:block`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockDelta {
    pub index: usize,
    /// For streaming text: the incremental text to append on the frontend so we
    /// don't resend the whole (growing) block. `None` = replace the whole block.
    pub text_append: Option<String>,
}

/// Builds one assistant turn's blocks from a stream of ACP session updates.
#[derive(Default)]
pub struct TurnAssembler {
    pub blocks: Vec<Block>,
    /// messageId -> block index, per stream, for chunk coalescing.
    text_idx: HashMap<String, usize>,
    thought_idx: HashMap<String, usize>,
    /// Fallback coalescing target when a chunk carries no messageId.
    last_text: Option<usize>,
    last_thought: Option<usize>,
    /// toolCallId -> (block index, raw ACP tool call) for update merging.
    tool_idx: HashMap<String, usize>,
    tool_raw: HashMap<String, acp::ToolCall>,
    counter: usize,
}

impl TurnAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply one ACP update. Returns a `BlockDelta` when it touched the block
    /// list; `None` for updates the manager handles itself (plan, config, mode,
    /// title, usage, commands).
    pub fn apply(&mut self, update: &acp::SessionUpdate) -> Option<BlockDelta> {
        match update {
            acp::SessionUpdate::AgentMessageChunk(chunk) => self.apply_chunk(chunk, false),
            acp::SessionUpdate::AgentThoughtChunk(chunk) => self.apply_chunk(chunk, true),
            acp::SessionUpdate::ToolCall(tc) => Some(self.apply_tool_call(tc)),
            acp::SessionUpdate::ToolCallUpdate(u) => self.apply_tool_update(u),
            _ => None,
        }
    }

    fn next_id(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{prefix}-{}", self.counter)
    }

    fn apply_chunk(&mut self, chunk: &acp::ContentChunk, is_thought: bool) -> Option<BlockDelta> {
        let msg_id = chunk.message_id.as_ref().map(|m| m.0.to_string());
        match &chunk.content {
            acp::ContentBlock::Text(t) => Some(self.append_text(is_thought, msg_id, &t.text)),
            acp::ContentBlock::Image(img) => {
                let url = img.uri.clone().unwrap_or_else(|| format!("data:{};base64,{}", img.mime_type, img.data));
                let block_id = self.next_id("file");
                self.blocks.push(Block::File { block_id, name: None, mime: Some(img.mime_type.clone()), url });
                Some(BlockDelta { index: self.blocks.len() - 1, text_append: None })
            }
            _ => None,
        }
    }

    fn append_text(&mut self, is_thought: bool, msg_id: Option<String>, text: &str) -> BlockDelta {
        // Find the block this chunk continues: by messageId, else the last block
        // of this stream when the chunk is unkeyed.
        let existing = match &msg_id {
            Some(k) => {
                let map = if is_thought { &self.thought_idx } else { &self.text_idx };
                map.get(k).copied()
            }
            None => {
                if is_thought {
                    self.last_thought
                } else {
                    self.last_text
                }
            }
        };

        if let Some(idx) = existing {
            match &mut self.blocks[idx] {
                Block::Text { text: t, .. } | Block::Reasoning { text: t, .. } => t.push_str(text),
                _ => {}
            }
            return BlockDelta { index: idx, text_append: Some(text.to_string()) };
        }

        let prefix = if is_thought { "thought" } else { "text" };
        let block_id = match &msg_id {
            Some(m) => format!("{prefix}-{m}"),
            None => self.next_id(prefix),
        };
        let block = if is_thought {
            Block::Reasoning { block_id, text: text.to_string() }
        } else {
            Block::Text { block_id, text: text.to_string() }
        };
        self.blocks.push(block);
        let idx = self.blocks.len() - 1;
        if let Some(k) = msg_id {
            if is_thought {
                self.thought_idx.insert(k, idx);
            } else {
                self.text_idx.insert(k, idx);
            }
        }
        if is_thought {
            self.last_thought = Some(idx);
        } else {
            self.last_text = Some(idx);
        }
        BlockDelta { index: idx, text_append: None }
    }

    fn apply_tool_call(&mut self, tc: &acp::ToolCall) -> BlockDelta {
        let call_id = tc.tool_call_id.0.to_string();
        self.tool_raw.insert(call_id.clone(), tc.clone());
        let block = Block::Tool(Box::new(tool_block(tc)));
        if let Some(&idx) = self.tool_idx.get(&call_id) {
            self.blocks[idx] = block;
            BlockDelta { index: idx, text_append: None }
        } else {
            self.blocks.push(block);
            let idx = self.blocks.len() - 1;
            self.tool_idx.insert(call_id, idx);
            BlockDelta { index: idx, text_append: None }
        }
    }

    fn apply_tool_update(&mut self, u: &acp::ToolCallUpdate) -> Option<BlockDelta> {
        let call_id = u.tool_call_id.0.to_string();
        // Merge onto the raw ACP tool call using the crate's own merge, then
        // re-derive our block. If we never saw the initiating ToolCall, seed a
        // minimal one so an out-of-order update still renders.
        let raw = self
            .tool_raw
            .entry(call_id.clone())
            .or_insert_with(|| acp::ToolCall::new(u.tool_call_id.clone(), String::new()));
        raw.update(u.fields.clone());
        let block = Block::Tool(Box::new(tool_block(raw)));
        if let Some(&idx) = self.tool_idx.get(&call_id) {
            self.blocks[idx] = block;
            Some(BlockDelta { index: idx, text_append: None })
        } else {
            self.blocks.push(block);
            let idx = self.blocks.len() - 1;
            self.tool_idx.insert(call_id, idx);
            Some(BlockDelta { index: idx, text_append: None })
        }
    }
}

fn map_status(s: acp::ToolCallStatus) -> ToolStatus {
    match s {
        acp::ToolCallStatus::Pending => ToolStatus::Pending,
        acp::ToolCallStatus::InProgress => ToolStatus::Running,
        acp::ToolCallStatus::Completed => ToolStatus::Completed,
        acp::ToolCallStatus::Failed => ToolStatus::Failed,
        _ => ToolStatus::Pending,
    }
}

/// Map ACP's coarse `ToolKind` to our tool name. The name drives the collapse
/// summary (edit/bash detection) and the frontend's per-tool label.
fn tool_name(kind: &acp::ToolKind, raw_input: Option<&serde_json::Value>, title: &str) -> String {
    let base = match kind {
        acp::ToolKind::Read => "read",
        acp::ToolKind::Edit => "edit",
        acp::ToolKind::Delete => "delete",
        acp::ToolKind::Move => "move",
        acp::ToolKind::Search => "search",
        acp::ToolKind::Execute => "bash",
        acp::ToolKind::Think => "think",
        acp::ToolKind::Fetch => "fetch",
        acp::ToolKind::SwitchMode => "switch_mode",
        _ => "",
    };
    if !base.is_empty() {
        return base.to_string();
    }
    // Kind::Other: try the raw input's tool name, else the first word of the title.
    if let Some(name) = raw_input.and_then(|v| v.get("tool")).and_then(|v| v.as_str()) {
        return name.to_string();
    }
    title.split_whitespace().next().unwrap_or("tool").to_lowercase()
}

fn tool_block(tc: &acp::ToolCall) -> ToolBlock {
    let call_id = tc.tool_call_id.0.to_string();
    let mut diff = None;
    let mut output = String::new();
    for c in &tc.content {
        match c {
            acp::ToolCallContent::Diff(d) => {
                diff = Some(DiffBlock {
                    path: d.path.to_string_lossy().into_owned(),
                    old_text: d.old_text.clone(),
                    new_text: d.new_text.clone(),
                    unified: None,
                });
            }
            acp::ToolCallContent::Content(cc) => {
                if let acp::ContentBlock::Text(t) = &cc.content {
                    if !output.is_empty() {
                        output.push('\n');
                    }
                    output.push_str(&t.text);
                }
            }
            _ => {}
        }
    }
    ToolBlock {
        block_id: format!("tool-{call_id}"),
        call_id,
        name: tool_name(&tc.kind, tc.raw_input.as_ref(), &tc.title),
        title: (!tc.title.is_empty()).then(|| tc.title.clone()),
        status: map_status(tc.status),
        input: tc.raw_input.clone().unwrap_or(serde_json::Value::Null),
        output: (!output.is_empty()).then_some(output),
        diff,
        error: None,
    }
}

fn category_str(c: &acp::SessionConfigOptionCategory) -> String {
    match c {
        acp::SessionConfigOptionCategory::Mode => "mode".into(),
        acp::SessionConfigOptionCategory::Model => "model".into(),
        acp::SessionConfigOptionCategory::ModelConfig => "modelConfig".into(),
        acp::SessionConfigOptionCategory::ThoughtLevel => "thoughtLevel".into(),
        acp::SessionConfigOptionCategory::Other(s) => s.clone(),
        _ => "other".into(),
    }
}

fn choice(c: &acp::SessionConfigSelectOption, group: Option<String>) -> ConfigChoice {
    ConfigChoice { value: c.value.0.to_string(), name: c.name.clone(), description: c.description.clone(), group }
}

/// Flatten ACP session config options into the UI-facing `ConfigOption` list
/// that drives the model / reasoning / mode selectors. Non-select options
/// (e.g. the unstable boolean kind) are skipped.
pub fn map_config_options(opts: &[acp::SessionConfigOption]) -> Vec<ConfigOption> {
    let mut out = Vec::new();
    for o in opts {
        let acp::SessionConfigKind::Select(sel) = &o.kind else {
            // Only Select options drive the selectors. Log anything else (e.g. a
            // reasoning/thoughtLevel option in a non-Select kind) so we can see
            // whether opencode advertises reasoning-effort at all (§F1a).
            crate::logf!("acp", "config option SKIPPED (non-select) id={} category={:?}", o.id.0, o.category);
            continue;
        };
        let mut choices = Vec::new();
        match &sel.options {
            acp::SessionConfigSelectOptions::Ungrouped(list) => {
                for c in list {
                    choices.push(choice(c, None));
                }
            }
            acp::SessionConfigSelectOptions::Grouped(groups) => {
                for g in groups {
                    for c in &g.options {
                        choices.push(choice(c, Some(g.name.clone())));
                    }
                }
            }
            _ => {}
        }
        out.push(ConfigOption {
            id: o.id.0.to_string(),
            name: o.name.clone(),
            description: o.description.clone(),
            category: o.category.as_ref().map(category_str),
            current_value: sel.current_value.0.to_string(),
            choices,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_chunk(text: &str, msg: Option<&str>) -> acp::SessionUpdate {
        let mut c = acp::ContentChunk::new(acp::ContentBlock::Text(acp::TextContent::new(text)));
        if let Some(m) = msg {
            c = c.message_id(m);
        }
        acp::SessionUpdate::AgentMessageChunk(c)
    }

    #[test]
    fn text_chunks_with_same_message_id_coalesce() {
        let mut a = TurnAssembler::new();
        let d1 = a.apply(&text_chunk("Hel", Some("m1"))).unwrap();
        assert_eq!(d1.text_append, None); // first chunk = new block
        let d2 = a.apply(&text_chunk("lo", Some("m1"))).unwrap();
        assert_eq!(d2.index, d1.index);
        assert_eq!(d2.text_append.as_deref(), Some("lo"));
        assert_eq!(a.blocks.len(), 1);
        match &a.blocks[0] {
            Block::Text { text, .. } => assert_eq!(text, "Hello"),
            _ => panic!("expected text block"),
        }
    }

    #[test]
    fn different_message_id_starts_new_block() {
        let mut a = TurnAssembler::new();
        a.apply(&text_chunk("first", Some("m1")));
        a.apply(&text_chunk("second", Some("m2")));
        assert_eq!(a.blocks.len(), 2);
    }

    #[test]
    fn thought_and_text_are_separate_blocks() {
        let mut a = TurnAssembler::new();
        let thought = acp::SessionUpdate::AgentThoughtChunk(acp::ContentChunk::new(acp::ContentBlock::Text(
            acp::TextContent::new("hmm"),
        )));
        a.apply(&thought);
        a.apply(&text_chunk("answer", None));
        assert_eq!(a.blocks.len(), 2);
        assert!(matches!(a.blocks[0], Block::Reasoning { .. }));
        assert!(matches!(a.blocks[1], Block::Text { .. }));
    }

    #[test]
    fn tool_call_then_update_merges_status_and_diff() {
        let mut a = TurnAssembler::new();
        let call = acp::ToolCall::new("c1", "Edit file")
            .kind(acp::ToolKind::Edit)
            .status(acp::ToolCallStatus::Pending)
            .raw_input(serde_json::json!({ "file": "a.rs" }));
        let d = a.apply(&acp::SessionUpdate::ToolCall(call)).unwrap();
        match &a.blocks[d.index] {
            Block::Tool(t) => {
                assert_eq!(t.name, "edit");
                assert_eq!(t.status, ToolStatus::Pending);
                assert!(t.diff.is_none());
            }
            _ => panic!("expected tool block"),
        }

        // Update: completed, with a diff. (ToolCallUpdateFields is #[non_exhaustive],
        // so build via Default + field assignment rather than a struct literal.)
        let mut fields = acp::ToolCallUpdateFields::default();
        fields.status = Some(acp::ToolCallStatus::Completed);
        fields.content = Some(vec![acp::ToolCallContent::Diff(acp::Diff::new("a.rs", "new contents"))]);
        let d2 = a.apply(&acp::SessionUpdate::ToolCallUpdate(acp::ToolCallUpdate::new("c1", fields))).unwrap();
        assert_eq!(d2.index, d.index); // same block, upserted
        assert_eq!(a.blocks.len(), 1);
        match &a.blocks[d2.index] {
            Block::Tool(t) => {
                assert_eq!(t.status, ToolStatus::Completed);
                let diff = t.diff.as_ref().expect("diff attached");
                assert_eq!(diff.path, "a.rs");
                assert_eq!(diff.new_text, "new contents");
            }
            _ => panic!("expected tool block"),
        }
    }

    #[test]
    fn config_options_flatten_for_ui() {
        let model_opt = acp::SessionConfigOption::select(
            "model",
            "Model",
            "anthropic/claude",
            vec![
                acp::SessionConfigSelectOption::new("anthropic/claude", "Claude Opus"),
                acp::SessionConfigSelectOption::new("openai/gpt", "GPT"),
            ],
        )
        .category(acp::SessionConfigOptionCategory::Model);

        let mapped = map_config_options(&[model_opt]);
        assert_eq!(mapped.len(), 1);
        let m = &mapped[0];
        assert_eq!(m.id, "model");
        assert_eq!(m.category.as_deref(), Some("model"));
        assert_eq!(m.current_value, "anthropic/claude");
        assert_eq!(m.choices.len(), 2);
        assert_eq!(m.choices[0].value, "anthropic/claude");
        assert_eq!(m.choices[0].name, "Claude Opus");
    }
}
