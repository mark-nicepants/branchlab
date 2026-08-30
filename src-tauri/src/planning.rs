//! AI planning over the task board — the model-driven half of `tasks.rs`.
//!
//! Two operations, both one throwaway prompt on the project's base engine:
//! **suggest a plan** (order + size existing subtasks) and **intake** (split
//! raw pasted content into subtasks, then order + size them). Each owns its
//! prompt, a tolerant JSON parse of the reply, and the resulting board
//! mutation; `commands.rs` only forwards the IPC call.
//!
//! Kept out of `tasks.rs` deliberately: that module is the persistence store
//! (pure, unit-testable, no engine), while everything here needs the chat
//! manager and produces prose for a model.

use std::collections::HashMap;
use std::path::Path;

use tauri::AppHandle;

use crate::chat::manager::ChatManager;
use crate::project::Registry;
use crate::tasks::{ColumnRole, EstimateUnit, TaskStore};

/// Result of an AI planning run: how many cards it touched, plus the model's
/// one-line rationale (when it produced a usable one).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedPlan {
    pub updated: usize,
    pub notes: Option<String>,
}

#[derive(serde::Deserialize)]
struct RawPlan {
    #[serde(default)]
    tasks: Vec<RawPlanTask>,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPlanTask {
    number: u64,
    #[serde(default)]
    blocked_by: Vec<u64>,
    #[serde(default)]
    estimate: Option<f64>,
}

#[derive(serde::Deserialize)]
struct RawIntake {
    #[serde(default)]
    tasks: Vec<RawIntakeTask>,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIntakeTask {
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    blocked_by: Vec<usize>,
    #[serde(default)]
    estimate: Option<f64>,
}

/// How to phrase the size estimate for the unit this project uses (its
/// override, else the board's).
fn estimate_unit(registry: &Registry, tasks: &TaskStore, project_id: &str) -> EstimateUnit {
    registry.project_estimate_unit(project_id).unwrap_or_else(|| tasks.estimate_unit())
}

/// AI plan for a parent task's subtasks: propose blocked-by ordering and size
/// estimates over a throwaway session on the project's base engine, and apply
/// them to the board.
pub async fn suggest_plan(
    parent_id: &str,
    app: &AppHandle,
    registry: &Registry,
    chat: &ChatManager,
    tasks: &TaskStore,
) -> Result<SuggestedPlan, String> {
    let snap = tasks.snapshot();
    let parent = snap.tasks.iter().find(|t| t.id == parent_id).ok_or("unknown task")?;
    let children: Vec<_> = snap.tasks.iter().filter(|t| t.parent_id.as_deref() == Some(parent_id)).collect();
    if children.len() < 2 {
        return Err("add at least two subtasks first".into());
    }
    let project_id =
        parent.project_id.clone().ok_or("give the task a project first — the AI runs on the project's engine")?;
    let base = registry.base_workspace(&project_id).ok_or("unknown project")?;

    let mut listing = String::new();
    for c in &children {
        listing.push_str(&format!("- #{}: {}", c.number, c.title));
        if let Some(d) = &c.description {
            listing.push_str(&format!(" — {}", d.replace('\n', " ")));
        }
        listing.push('\n');
    }
    let estimate_rule = match estimate_unit(registry, tasks, &project_id) {
        EstimateUnit::Points => "estimate its size in story points (1, 2, 3, 5, 8, 13)",
        EstimateUnit::Hours => "estimate its size in hours (fractions allowed)",
        EstimateUnit::Tshirt => "estimate its t-shirt size expressed as a number: XS=1, S=2, M=3, L=5, XL=8",
    };
    let prompt = format!(
        "You are planning subtasks of the development task \"{}\"{} in this repository.\n\nSubtasks:\n{}\n\
         For each subtask, decide which sibling subtasks (if any) must be finished before it can start, and \
         {estimate_rule}. Independent subtasks get an empty blockedBy so they can \
         run in parallel; only add an ordering the work genuinely requires. Skim the repository if that helps.\n\n\
         Reply with ONLY this JSON, no prose:\n\
         {{\"tasks\":[{{\"number\":1,\"blockedBy\":[2],\"estimate\":1.5}}],\"notes\":\"<one sentence on the ordering>\"}}",
        parent.title,
        parent.description.as_deref().map(|d| format!(" ({d})")).unwrap_or_default(),
        listing,
    );

    let raw =
        chat.one_shot(&base.id, Path::new(&base.path), prompt).await.ok_or("the model did not return a usable plan")?;
    let parsed: RawPlan = crate::util::json_blob(&raw).ok_or("the model did not return a usable plan")?;

    let by_number: HashMap<u64, String> = children.iter().map(|c| (c.number, c.id.clone())).collect();
    let plan: Vec<(String, Vec<String>, Option<f64>)> = parsed
        .tasks
        .into_iter()
        .filter_map(|t| {
            let id = by_number.get(&t.number)?.clone();
            let deps = t.blocked_by.iter().filter_map(|n| by_number.get(n).cloned()).collect();
            Some((id, deps, t.estimate.filter(|e| *e > 0.0)))
        })
        .collect();
    let updated = tasks.apply_plan(parent_id, plan);
    if updated > 0 {
        crate::tasks::emit_changed(app, tasks);
    }
    Ok(SuggestedPlan { updated, notes: parsed.notes.filter(|n| !n.trim().is_empty()) })
}

/// AI intake: split pasted raw content (client email, meeting notes, Excel
/// rows — anything) into subtasks of `parent_id`, with dependencies and
/// estimates, over a throwaway session on the project's base engine.
pub async fn intake(
    parent_id: &str,
    content: &str,
    app: &AppHandle,
    registry: &Registry,
    chat: &ChatManager,
    tasks: &TaskStore,
) -> Result<SuggestedPlan, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("nothing to split — paste some content first".into());
    }
    let content: String = content.chars().take(12_000).collect();
    let snap = tasks.snapshot();
    let parent = snap.tasks.iter().find(|t| t.id == parent_id).ok_or("unknown task")?;
    if parent.parent_id.is_some() {
        return Err("subtasks cannot be nested — split from the parent task".into());
    }
    let project_id =
        parent.project_id.clone().ok_or("give the task a project first — the AI runs on the project's engine")?;
    let base = registry.base_workspace(&project_id).ok_or("unknown project")?;

    let estimate_rule = match estimate_unit(registry, tasks, &project_id) {
        EstimateUnit::Points => "story points (1, 2, 3, 5, 8, 13)",
        EstimateUnit::Hours => "hours (fractions allowed)",
        EstimateUnit::Tshirt => "t-shirt sizes as numbers (XS=1, S=2, M=3, L=5, XL=8)",
    };
    let prompt = format!(
        "You are splitting raw input into development subtasks of the task \"{}\"{} in this repository.\n\n\
         RAW INPUT (may be an email, meeting notes, or spreadsheet rows — tab-separated cells):\n---\n{}\n---\n\n\
         Extract each distinct actionable piece of work as one subtask: a short imperative title, and a \
         description carrying the relevant details from the input (quote the source where useful — do not \
         invent requirements). Merge duplicates; skip non-actionable chatter. Estimate each in {estimate_rule}. \
         blockedBy lists the 0-based INDEXES of subtasks in your own list that must land first — only where the \
         work genuinely requires it; independent subtasks run in parallel. Skim the repository if that helps.\n\n\
         Reply with ONLY this JSON, no prose:\n\
         {{\"tasks\":[{{\"title\":\"…\",\"description\":\"…\",\"estimate\":2,\"blockedBy\":[0]}}],\"notes\":\"<one sentence>\"}}",
        parent.title,
        parent.description.as_deref().map(|d| format!(" ({d})")).unwrap_or_default(),
        content,
    );

    let raw = chat
        .one_shot(&base.id, Path::new(&base.path), prompt)
        .await
        .ok_or("the model did not return a usable split")?;
    let parsed: RawIntake = crate::util::json_blob(&raw).ok_or("the model did not return a usable split")?;
    if parsed.tasks.is_empty() {
        return Err("the model found nothing actionable in that content".into());
    }

    // Children land in the parent's column when it's the active one (the
    // batch is already delegated), else in the default first column.
    let active_parent = snap.columns.iter().any(|c| c.id == parent.column_id && c.role == ColumnRole::Active);
    let column = active_parent.then(|| parent.column_id.clone());

    let mut ids: Vec<String> = Vec::new();
    for t in &parsed.tasks {
        let created = tasks.create_task(
            t.title.clone(),
            t.description.clone().filter(|d| !d.trim().is_empty()),
            None,
            column.clone(),
            Some(parent_id.to_string()),
        )?;
        ids.push(created.id);
    }
    let plan: Vec<(String, Vec<String>, Option<f64>)> = parsed
        .tasks
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let deps = t.blocked_by.iter().filter(|&&d| d < ids.len() && d != i).map(|&d| ids[d].clone()).collect();
            (ids[i].clone(), deps, t.estimate.filter(|e| *e > 0.0))
        })
        .collect();
    tasks.apply_plan(parent_id, plan);
    tasks.record_event(parent_id, "plan", "ai", &format!("split the pasted content into {} subtasks", ids.len()));
    crate::tasks::emit_changed(app, tasks);
    Ok(SuggestedPlan { updated: ids.len(), notes: parsed.notes.filter(|n| !n.trim().is_empty()) })
}
