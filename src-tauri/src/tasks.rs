//! The "My work" task board — a local-first store of columns + task cards.
//!
//! Same persistence pattern as the project registry (Mutex + JSON file,
//! persist-on-write), but a separate `tasks.json`: the board is designed to
//! become a cloud-sync unit later (branchlab.dev), so every record carries a
//! ULID id, an `updated_at` LWW key, and deletes are tombstones instead of
//! removals. No sync exists yet — the shape just doesn't preclude it.
//!
//! Custom columns are reconciled with session auto-tracking via ROLES: at
//! most one column is `active` (cards land here when their session starts)
//! and one is `done` (cards land here when the linked PR merges or the
//! workspace is deleted). Ordering is a per-column fractional index
//! (`position: f64`); the frontend sends midpoints and the store renumbers a
//! column when the gaps get too small.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// Gap between positions when (re)numbering from scratch.
const STRIDE: f64 = 1024.0;
/// Below this neighbor gap a column is renumbered before inserting.
const MIN_GAP: f64 = 1e-6;

/// One line in a task's activity feed. `kind` is either "comment" (user
/// prose), "command" (a /slash comment), or a recorded event: created |
/// session | review | resumed | moved | done | plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: String,
    pub task_id: String,
    pub kind: String,
    /// Comment text, or a short event detail ("In progress", "PR #57 merged").
    #[serde(default)]
    pub body: String,
    /// "user" | "agent" | "ai"
    pub actor: String,
    pub created_at: i64,
}

/// How estimates are read: story points (default), hours, or t-shirt sizes
/// (stored as their numeric value: XS=1 S=2 M=3 L=5 XL=8). Board-global with
/// a per-project override on `Project`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum EstimateUnit {
    #[default]
    Points,
    Hours,
    Tshirt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ColumnRole {
    #[default]
    None,
    /// Legacy (pre-merge boards): folded into Active by canonicalize().
    Queued,
    /// Queue + work in one column: unlinked cards await dispatch, linked
    /// cards are in progress.
    Active,
    /// Finished turns park their card here until the user reacts.
    Review,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub role: ColumnRole,
    pub position: f64,
    pub updated_at: i64,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    /// Human reference (#7) — incremental per board, assigned at creation.
    /// ponytail: per-device counter; a future cloud sync needs a merge rule.
    #[serde(default)]
    pub number: u64,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    pub column_id: String,
    pub position: f64,
    /// Linked session. KEPT after workspace deletion — it keys the archived
    /// chat transcript in chat.db (resolve against the registry to know
    /// whether the session is live).
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Subtask hierarchy (v2 UI): the main board shows only parentless tasks.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Dispatch dependencies: queued tasks wait until every dep is done.
    /// Sequential batches are chains; parallel batches have no deps.
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// Rough size in hours — user-entered, AI-suggested, or imported from a
    /// GitHub Projects "Estimate" field.
    #[serde(default)]
    pub estimate: Option<f64>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

/// On-disk shape (includes tombstones).
#[derive(Debug, Default, Serialize, Deserialize)]
struct BoardData {
    columns: Vec<Column>,
    tasks: Vec<Task>,
    /// Next task number to hand out (backfilled from existing tasks on load).
    #[serde(default)]
    next_task_number: u64,
    /// Board-global estimate unit (projects can override).
    #[serde(default)]
    estimate_unit: EstimateUnit,
    /// Append-only per-task activity feed (events + comments).
    #[serde(default)]
    activity: Vec<ActivityEntry>,
}

/// What the frontend sees: live records only, sorted by position.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSnapshot {
    pub columns: Vec<Column>,
    pub tasks: Vec<Task>,
    pub estimate_unit: EstimateUnit,
}

/// A task whose workspace link was just severed by a deletion — the UI
/// offers to mark it done instead of the store deciding.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkedTask {
    pub task_id: String,
    pub title: String,
}

/// Partial task update (None = leave unchanged; `Some(None)` isn't needed —
/// clearing project/description passes an empty string, normalized below).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub project_id: Option<String>,
    /// Hours; a negative value clears the estimate (JSON has no "unset").
    pub estimate: Option<f64>,
    /// Replaces the whole blocked-by list. Unknown/self ids are dropped.
    pub depends_on: Option<Vec<String>>,
}

pub struct TaskStore {
    data: Mutex<BoardData>,
    file: PathBuf,
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Append an activity entry (caller holds the lock and persists).
fn record(data: &mut BoardData, task_id: &str, kind: &str, actor: &str, body: impl Into<String>) {
    data.activity.push(ActivityEntry {
        id: new_id(),
        task_id: task_id.to_string(),
        kind: kind.to_string(),
        body: body.into(),
        actor: actor.to_string(),
        created_at: now_ms(),
    });
}

fn new_id() -> String {
    ulid::Ulid::generate().to_string()
}

impl TaskStore {
    /// Load from `file`, seeding the default Todo/In progress/Done board on
    /// first run (or when every column was deleted).
    pub fn load(file: PathBuf) -> Self {
        let mut data: BoardData =
            std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        canonicalize(&mut data);
        backfill_numbers(&mut data);
        let store = Self { data: Mutex::new(data), file };
        store.persist(&store.data.lock().unwrap());
        store
    }

    fn persist(&self, data: &BoardData) {
        if let Some(parent) = self.file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(data) {
            let _ = std::fs::write(&self.file, json);
        }
    }

    pub fn snapshot(&self) -> BoardSnapshot {
        let data = self.data.lock().unwrap();
        let mut columns: Vec<Column> = data.columns.iter().filter(|c| c.deleted_at.is_none()).cloned().collect();
        let mut tasks: Vec<Task> = data.tasks.iter().filter(|t| t.deleted_at.is_none()).cloned().collect();
        columns.sort_by(|a, b| a.position.total_cmp(&b.position));
        tasks.sort_by(|a, b| a.position.total_cmp(&b.position));
        BoardSnapshot { columns, tasks, estimate_unit: data.estimate_unit }
    }

    pub fn estimate_unit(&self) -> EstimateUnit {
        self.data.lock().unwrap().estimate_unit
    }

    pub fn set_estimate_unit(&self, unit: EstimateUnit) {
        let mut data = self.data.lock().unwrap();
        data.estimate_unit = unit;
        self.persist(&data);
    }

    pub fn create_task(
        &self,
        title: String,
        description: Option<String>,
        project_id: Option<String>,
        column_id: Option<String>,
        parent_id: Option<String>,
    ) -> Result<Task, String> {
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err("task title is empty".into());
        }
        let mut data = self.data.lock().unwrap();
        // Subtasks inherit their parent's project so dispatch never needs
        // hierarchy awareness; a subtask of a subtask is refused (one level).
        let mut project_id = project_id;
        if let Some(pid) = &parent_id {
            let parent =
                data.tasks.iter().find(|t| &t.id == pid && t.deleted_at.is_none()).ok_or("unknown parent task")?;
            if parent.parent_id.is_some() {
                return Err("subtasks cannot be nested".into());
            }
            project_id = parent.project_id.clone();
        }
        let column_id = match column_id {
            Some(id) if data.columns.iter().any(|c| c.id == id && c.deleted_at.is_none()) => id,
            Some(_) => return Err("unknown column".into()),
            None => first_column(&data).ok_or("board has no columns")?,
        };
        let position = max_position(&data, &column_id) + STRIDE;
        let now = now_ms();
        let number = data.next_task_number.max(1);
        data.next_task_number = number + 1;
        let task = Task {
            id: new_id(),
            number,
            title,
            description: normalize(description),
            project_id: normalize(project_id),
            column_id,
            position,
            workspace_id: None,
            parent_id,
            depends_on: Vec::new(),
            estimate: None,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        };
        record(&mut data, &task.id, "created", "user", "");
        data.tasks.push(task.clone());
        self.persist(&data);
        Ok(task)
    }

    pub fn update_task(&self, id: &str, patch: TaskPatch) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
        let live: std::collections::HashSet<String> =
            data.tasks.iter().filter(|t| t.deleted_at.is_none()).map(|t| t.id.clone()).collect();
        let task = live_task(&mut data, id)?;
        if let Some(title) = patch.title {
            let title = title.trim().to_string();
            if title.is_empty() {
                return Err("task title is empty".into());
            }
            task.title = title;
        }
        if let Some(d) = patch.description {
            task.description = normalize(Some(d));
        }
        if let Some(p) = patch.project_id {
            task.project_id = normalize(Some(p));
        }
        if let Some(e) = patch.estimate {
            task.estimate = (e >= 0.0).then_some(e);
        }
        if let Some(deps) = patch.depends_on {
            let mut seen = std::collections::HashSet::new();
            task.depends_on =
                deps.into_iter().filter(|d| d != id && live.contains(d) && seen.insert(d.clone())).collect();
        }
        task.updated_at = now_ms();
        self.persist(&data);
        Ok(())
    }

    pub fn delete_task(&self, id: &str) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
        let now = now_ms();
        {
            let task = live_task(&mut data, id)?;
            task.deleted_at = Some(now);
            task.updated_at = now;
        }
        // A parent's deletion must not orphan subtasks on the board.
        for t in data.tasks.iter_mut().filter(|t| t.deleted_at.is_none() && t.parent_id.as_deref() == Some(id)) {
            t.deleted_at = Some(now);
            t.updated_at = now;
        }
        self.persist(&data);
        Ok(())
    }

    /// Move within/between columns. `position` is the caller-computed
    /// fractional index; when the target column's gaps are exhausted the
    /// column is renumbered and the task appended at the requested rank.
    pub fn move_task(&self, id: &str, column_id: &str, position: f64) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
        if !data.columns.iter().any(|c| c.id == column_id && c.deleted_at.is_none()) {
            return Err("unknown column".into());
        }
        let col_name = data.columns.iter().find(|c| c.id == column_id).map(|c| c.name.clone()).unwrap_or_default();
        {
            let task = live_task(&mut data, id)?;
            let moved = task.column_id != column_id;
            task.column_id = column_id.to_string();
            task.position = position;
            task.updated_at = now_ms();
            if moved {
                record(&mut data, id, "moved", "user", col_name.clone());
            }
        }
        // Delegating a parent delegates the batch: its not-yet-started
        // children follow into the active column (deps still gate dispatch,
        // so sequential chains drain in order). Children already in review
        // or done are left where they are.
        let target_role = data.columns.iter().find(|c| c.id == column_id).map(|c| c.role);
        if target_role == Some(ColumnRole::Active) {
            let skip: std::collections::HashSet<String> = data
                .columns
                .iter()
                .filter(|c| matches!(c.role, ColumnRole::Active | ColumnRole::Review | ColumnRole::Done))
                .map(|c| c.id.clone())
                .collect();
            let mut kids: Vec<usize> = (0..data.tasks.len())
                .filter(|&i| {
                    let c = &data.tasks[i];
                    c.deleted_at.is_none() && c.parent_id.as_deref() == Some(id) && !skip.contains(&c.column_id)
                })
                .collect();
            kids.sort_by_key(|&i| data.tasks[i].number);
            if !kids.is_empty() {
                let mut pos = max_position(&data, column_id);
                let now = now_ms();
                let n = kids.len();
                for i in kids {
                    pos += STRIDE;
                    let c = &mut data.tasks[i];
                    c.column_id = column_id.to_string();
                    c.position = pos;
                    c.updated_at = now;
                }
                record(&mut data, id, "moved", "user", format!("{col_name} — queued {n} subtasks"));
            }
        }
        renumber_if_cramped(&mut data, column_id);
        self.persist(&data);
        Ok(())
    }

    /// Link a task to a freshly started session and move it to the active
    /// column (when one is assigned).
    pub fn link_workspace(&self, id: &str, workspace_id: &str) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
        let active = role_column(&data, ColumnRole::Active);
        let max = active.as_ref().map(|c| max_position(&data, c)).unwrap_or(0.0);
        let task = live_task(&mut data, id)?;
        task.workspace_id = Some(workspace_id.to_string());
        if let Some(col) = active {
            task.column_id = col.clone();
            task.position = max + STRIDE;
        }
        task.updated_at = now_ms();
        let id = task.id.clone();
        record(&mut data, &id, "session", "agent", "");
        self.persist(&data);
        Ok(())
    }

    /// The linked session finished its arc (PR merged). Move to the done
    /// column. Quiet no-op when nothing is linked.
    pub fn on_workspace_done(&self, workspace_id: &str) -> bool {
        let mut data = self.data.lock().unwrap();
        let done = role_column(&data, ColumnRole::Done);
        let max = done.as_ref().map(|c| max_position(&data, c)).unwrap_or(0.0);
        let Some(task) =
            data.tasks.iter_mut().find(|t| t.deleted_at.is_none() && t.workspace_id.as_deref() == Some(workspace_id))
        else {
            return false;
        };
        if let Some(col) = done {
            if task.column_id != col {
                task.column_id = col;
                task.position = max + STRIDE;
            }
        }
        task.updated_at = now_ms();
        let id = task.id.clone();
        record(&mut data, &id, "done", "agent", "PR merged");
        self.persist(&data);
        true
    }

    /// The linked workspace was deleted: only clear the link (the id would
    /// dangle) — deletion is not proof the work landed, so nothing moves.
    /// Returns the task so the UI can OFFER "mark as done"; suppressed when
    /// the task already sits in the done column (e.g. merge moved it first).
    pub fn on_workspace_removed(&self, workspace_id: &str) -> Option<UnlinkedTask> {
        // The link is KEPT: the chat.db transcript is keyed by this workspace
        // id and survives deletion, so the card can open the archived chat.
        let data = self.data.lock().unwrap();
        let done = role_column(&data, ColumnRole::Done);
        let task =
            data.tasks.iter().find(|t| t.deleted_at.is_none() && t.workspace_id.as_deref() == Some(workspace_id))?;
        (done.as_deref() != Some(task.column_id.as_str()))
            .then(|| UnlinkedTask { task_id: task.id.clone(), title: task.title.clone() })
    }

    /// Move a task to the done-role column (the "mark as done" toast action).
    pub fn mark_done(&self, id: &str) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
        let done = role_column(&data, ColumnRole::Done).ok_or("no done column")?;
        let max = max_position(&data, &done);
        let task = live_task(&mut data, id)?;
        if task.column_id != done {
            task.column_id = done;
            task.position = max + STRIDE;
            record(&mut data, id, "done", "user", "");
        }
        let task = live_task(&mut data, id)?;
        task.updated_at = now_ms();
        self.persist(&data);
        Ok(())
    }

    /// Apply an AI-suggested plan to a parent's live children: replace each
    /// listed child's blocked-by list and estimate in one persist. Ids not
    /// among the parent's live children are ignored; dep ids are validated
    /// the same way `update_task` does. Returns how many tasks changed.
    pub fn apply_plan(&self, parent_id: &str, plan: Vec<(String, Vec<String>, Option<f64>)>) -> usize {
        let mut data = self.data.lock().unwrap();
        let children: std::collections::HashSet<String> = data
            .tasks
            .iter()
            .filter(|t| t.deleted_at.is_none() && t.parent_id.as_deref() == Some(parent_id))
            .map(|t| t.id.clone())
            .collect();
        let now = now_ms();
        let mut changed = 0;
        for (id, deps, estimate) in plan {
            if !children.contains(&id) {
                continue;
            }
            let mut seen = std::collections::HashSet::new();
            let deps: Vec<String> =
                deps.into_iter().filter(|d| *d != id && children.contains(d) && seen.insert(d.clone())).collect();
            let Some(t) = data.tasks.iter_mut().find(|t| t.id == id) else { continue };
            if t.depends_on != deps || (estimate.is_some() && t.estimate != estimate) {
                t.depends_on = deps;
                if estimate.is_some() {
                    t.estimate = estimate;
                }
                t.updated_at = now;
                changed += 1;
            }
        }
        if changed > 0 {
            record(&mut data, parent_id, "plan", "ai", format!("planned {changed} subtasks"));
            self.persist(&data);
        }
        changed
    }

    /// A task's activity feed, oldest first (insertion order — created_at has
    /// millisecond ties within one action).
    pub fn activity(&self, task_id: &str) -> Vec<ActivityEntry> {
        self.data.lock().unwrap().activity.iter().filter(|a| a.task_id == task_id).cloned().collect()
    }

    /// `create_task` for the agent bridge: same semantics, but the "created"
    /// feed event carries actor "agent" so provenance is visible.
    pub fn create_task_from_agent(
        &self,
        title: String,
        description: Option<String>,
        parent_id: Option<String>,
    ) -> Result<Task, String> {
        let task = self.create_task(title, description, None, None, parent_id)?;
        let mut data = self.data.lock().unwrap();
        if let Some(a) = data.activity.iter_mut().rev().find(|a| a.task_id == task.id && a.kind == "created") {
            a.actor = "agent".into();
        }
        self.persist(&data);
        drop(data);
        Ok(task)
    }

    /// Look a live task up by its human #number.
    pub fn find_by_number(&self, number: u64) -> Option<Task> {
        self.data.lock().unwrap().tasks.iter().find(|t| t.number == number && t.deleted_at.is_none()).cloned()
    }

    /// Record a board event from the command layer (e.g. AI intake).
    pub fn record_event(&self, task_id: &str, kind: &str, actor: &str, body: &str) {
        let mut data = self.data.lock().unwrap();
        record(&mut data, task_id, kind, actor, body);
        self.persist(&data);
    }

    /// Append a user comment ("comment") or a slash command ("command").
    pub fn add_comment(&self, task_id: &str, kind: &str, actor: &str, body: &str) -> Result<ActivityEntry, String> {
        let body = body.trim();
        if body.is_empty() {
            return Err("empty comment".into());
        }
        let mut data = self.data.lock().unwrap();
        if !data.tasks.iter().any(|t| t.id == task_id && t.deleted_at.is_none()) {
            return Err("unknown task".into());
        }
        record(&mut data, task_id, kind, actor, body);
        let entry = data.activity.last().cloned().expect("just pushed");
        self.persist(&data);
        Ok(entry)
    }

    /// The kickoff prompt for a task session. Subtasks additionally carry
    /// the parent's goal and the sibling map so the agent scopes its work to
    /// THIS subtask instead of rediscovering the whole batch.
    pub fn kickoff_prompt(&self, task: &Task, project_name: Option<&str>) -> (String, String) {
        let (display, mut sent) = task_prompt(task, project_name);
        let data = self.data.lock().unwrap();
        if let Some(pid) = &task.parent_id {
            if let Some(parent) = data.tasks.iter().find(|t| &t.id == pid && t.deleted_at.is_none()) {
                sent.push_str(&format!("\nThis is a SUBTASK of #{} {}.", parent.number, parent.title));
                if let Some(d) = &parent.description {
                    let d: String = d.chars().take(600).collect();
                    sent.push_str(&format!("\nParent goal: {d}\n"));
                } else {
                    sent.push('\n');
                }
                let state_of = |t: &Task| -> &'static str {
                    match data.columns.iter().find(|c| c.id == t.column_id).map(|c| c.role) {
                        Some(ColumnRole::Done) => "done",
                        Some(ColumnRole::Review) => "in review",
                        Some(ColumnRole::Active) if t.workspace_id.is_some() => "in progress",
                        Some(ColumnRole::Active) => "queued",
                        _ => "todo",
                    }
                };
                let mut siblings: Vec<&Task> = data
                    .tasks
                    .iter()
                    .filter(|t| t.deleted_at.is_none() && t.parent_id.as_deref() == Some(pid.as_str()))
                    .collect();
                siblings.sort_by_key(|t| t.number);
                sent.push_str("Sibling subtasks:\n");
                for s in siblings {
                    let marker = if s.id == task.id { " <- YOU are this one" } else { "" };
                    sent.push_str(&format!("- #{} {} ({}){}\n", s.number, s.title, state_of(s), marker));
                }
                sent.push_str("Scope your work to YOUR subtask only — siblings are handled in their own sessions.\n");
            }
        }
        if !task.depends_on.is_empty() {
            let deps: Vec<String> = task
                .depends_on
                .iter()
                .filter_map(|d| data.tasks.iter().find(|t| &t.id == d).map(|t| format!("#{}", t.number)))
                .collect();
            if !deps.is_empty() {
                sent.push_str(&format!("Completed prerequisite tasks: {}.\n", deps.join(", ")));
            }
        }
        // Notes handed to this task (user comments, or findings another
        // session posted via branchlab_comment_task) ride the kickoff.
        let notes: Vec<&ActivityEntry> =
            data.activity.iter().filter(|a| a.task_id == task.id && a.kind == "comment").collect();
        if !notes.is_empty() {
            sent.push_str("Notes on this task:\n");
            for n in notes.iter().rev().take(6).rev() {
                sent.push_str(&format!("- {}: {}\n", n.actor, n.body));
            }
        }
        (display, sent)
    }

    // ── Workflow machine hooks (called by the supervisor) ───────────────────

    /// A linked session's turn finished: park the card in the review column —
    /// but only if it currently sits in the active column, so the user's
    /// manual placement always wins. Returns the task title on a move.
    pub fn on_turn_ended(&self, workspace_id: &str) -> Option<(String, String)> {
        self.move_between_roles(workspace_id, ColumnRole::Active, ColumnRole::Review)
    }

    /// A linked session started a new turn (feedback, composer message,
    /// autofix — any): pull the card from review back to active.
    pub fn on_turn_started(&self, workspace_id: &str) -> Option<(String, String)> {
        self.move_between_roles(workspace_id, ColumnRole::Review, ColumnRole::Active)
    }

    fn move_between_roles(&self, workspace_id: &str, from: ColumnRole, to: ColumnRole) -> Option<(String, String)> {
        let mut data = self.data.lock().unwrap();
        let from_col = role_column(&data, from)?;
        let to_col = role_column(&data, to)?;
        let max = max_position(&data, &to_col);
        let task = data
            .tasks
            .iter_mut()
            .find(|t| t.deleted_at.is_none() && t.workspace_id.as_deref() == Some(workspace_id))?;
        if task.column_id != from_col {
            return None;
        }
        task.column_id = to_col;
        task.position = max + STRIDE;
        task.updated_at = now_ms();
        let (id, title) = (task.id.clone(), task.title.clone());
        record(&mut data, &id, if to == ColumnRole::Review { "review" } else { "resumed" }, "agent", "");
        self.persist(&data);
        Some((id, title))
    }

    /// The next dispatchable card: an UNLINKED card in the active column is
    /// queued for pickup (linked cards there are in progress). Lowest position
    /// first; every dependency must sit in the done column (missing/tombstoned
    /// deps count as satisfied — a deleted dep must never deadlock the queue).
    /// Project-less tasks dispatch as quick chats.
    pub fn next_queued(&self) -> Option<Task> {
        let data = self.data.lock().unwrap();
        let queued = role_column(&data, ColumnRole::Active)?;
        let done = role_column(&data, ColumnRole::Done);
        let dep_done = |dep: &String| {
            data.tasks
                .iter()
                .find(|t| &t.id == dep && t.deleted_at.is_none())
                .is_none_or(|t| Some(t.column_id.as_str()) == done.as_deref())
        };
        let has_live_children =
            |id: &str| data.tasks.iter().any(|c| c.deleted_at.is_none() && c.parent_id.as_deref() == Some(id));
        data.tasks
            .iter()
            .filter(|t| {
                t.deleted_at.is_none()
                    && t.column_id == queued
                    && t.workspace_id.is_none()
                    && t.depends_on.iter().all(dep_done)
                    // Parents never run — their children are the work.
                    && !has_live_children(&t.id)
            })
            .min_by(|a, b| a.position.total_cmp(&b.position))
            .cloned()
    }

    /// Linked cards currently in the active column — the dispatch capacity
    /// measure. `is_live` filters out archived links (workspace deleted but
    /// the id kept for the chat archive), so dead sessions never eat a slot.
    pub fn active_count(&self, is_live: impl Fn(&str) -> bool) -> usize {
        let data = self.data.lock().unwrap();
        let Some(active) = role_column(&data, ColumnRole::Active) else { return 0 };
        data.tasks
            .iter()
            .filter(|t| {
                t.deleted_at.is_none() && t.column_id == active && t.workspace_id.as_deref().is_some_and(&is_live)
            })
            .count()
    }
}

/// The one true layout — columns are not user-editable.
const DEFAULT_COLUMNS: [(&str, ColumnRole); 4] = [
    ("Todo", ColumnRole::None),
    ("In progress", ColumnRole::Active),
    ("Needs review", ColumnRole::Review),
    ("Done", ColumnRole::Done),
];

/// Enforce the canonical layout: whenever the live columns don't match
/// DEFAULT_COLUMNS by role sequence, replace them and remap every task by its
/// old column's role (legacy Queued folds into Active; role-less customs land
/// in Todo). Runs on every load, which retires layout migrations forever.
fn canonicalize(data: &mut BoardData) {
    let mut live: Vec<&Column> = data.columns.iter().filter(|c| c.deleted_at.is_none()).collect();
    live.sort_by(|a, b| a.position.total_cmp(&b.position));
    let canonical = live.len() == DEFAULT_COLUMNS.len()
        && live.iter().zip(DEFAULT_COLUMNS).all(|(c, (name, role))| c.role == role && c.name == name);
    if canonical {
        return;
    }
    let now = now_ms();
    let old_roles: std::collections::HashMap<String, ColumnRole> =
        live.iter().map(|c| (c.id.clone(), c.role)).collect();
    for c in data.columns.iter_mut().filter(|c| c.deleted_at.is_none()) {
        c.deleted_at = Some(now);
        c.updated_at = now;
    }
    seed_default_columns(data);
    let by_role: std::collections::HashMap<ColumnRole, String> =
        data.columns.iter().filter(|c| c.deleted_at.is_none()).map(|c| (c.role, c.id.clone())).collect();
    let todo = data.columns.iter().find(|c| c.deleted_at.is_none()).map(|c| c.id.clone()).unwrap();
    for t in data.tasks.iter_mut().filter(|t| t.deleted_at.is_none()) {
        let mut role = old_roles.get(&t.column_id).copied().unwrap_or(ColumnRole::None);
        if role == ColumnRole::Queued {
            role = ColumnRole::Active;
        }
        t.column_id = by_role.get(&role).cloned().unwrap_or_else(|| todo.clone());
        t.updated_at = now;
    }
}

fn seed_default_columns(data: &mut BoardData) {
    let now = now_ms();
    for (i, (name, role)) in DEFAULT_COLUMNS.into_iter().enumerate() {
        data.columns.push(Column {
            id: new_id(),
            name: name.into(),
            role,
            position: STRIDE * (i as f64 + 1.0),
            updated_at: now,
            deleted_at: None,
        });
    }
}

/// Assign numbers to tasks created before numbering existed (oldest first)
/// and make sure the counter is ahead of every number ever handed out
/// (tombstones included — numbers are never reused).
fn backfill_numbers(data: &mut BoardData) {
    let mut max = data.tasks.iter().map(|t| t.number).max().unwrap_or(0);
    let mut unnumbered: Vec<usize> = (0..data.tasks.len()).filter(|&i| data.tasks[i].number == 0).collect();
    unnumbered.sort_by_key(|&i| data.tasks[i].created_at);
    for i in unnumbered {
        max += 1;
        data.tasks[i].number = max;
    }
    data.next_task_number = data.next_task_number.max(max + 1);
}

/// The prompt a task-dispatched session opens with: `display` is the readable
/// task text shown in the transcript; `sent` carries the structured context
/// block so the agent can see every task property.
/// Branch name for a task session: `task/<number>-<title-slug>`.
pub fn task_branch(task: &Task) -> String {
    let slug: String = task
        .title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join("-");
    let slug: String = slug.chars().take(40).collect();
    if slug.is_empty() {
        format!("task/{}", task.number)
    } else {
        format!("task/{}-{}", task.number, slug.trim_end_matches('-'))
    }
}

pub fn task_prompt(task: &Task, project_name: Option<&str>) -> (String, String) {
    let display = match &task.description {
        Some(d) => format!("{}\n\n{}", task.title, d),
        None => task.title.clone(),
    };
    let mut sent = display.clone();
    sent.push_str("\n\n---\nTask context (from the BranchLab board):\n");
    sent.push_str(&format!("- Task: #{} {}\n", task.number, task.title));
    if let Some(p) = project_name {
        sent.push_str(&format!("- Project: {p}\n"));
    }
    sent.push_str(&format!("- Task id: {}\n", task.id));
    sent.push_str("Refer to this task as #");
    sent.push_str(&task.number.to_string());
    sent.push_str(" when summarizing.\n");
    sent.push_str(
        "Board tools are available over MCP: branchlab_list_tasks and branchlab_get_task \
         fetch live details (description, state, comments) for any task #number. You can also WRITE to the \
         board: branchlab_comment_task posts a note to a task's feed — use it to hand findings or context to \
         another task (its future session will see them) — and branchlab_create_task files follow-up work you \
         discover.\n",
    );
    (display, sent)
}

fn normalize(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn first_column(data: &BoardData) -> Option<String> {
    data.columns
        .iter()
        .filter(|c| c.deleted_at.is_none())
        .min_by(|a, b| a.position.total_cmp(&b.position))
        .map(|c| c.id.clone())
}

fn role_column(data: &BoardData, role: ColumnRole) -> Option<String> {
    data.columns.iter().find(|c| c.deleted_at.is_none() && c.role == role).map(|c| c.id.clone())
}

fn max_position(data: &BoardData, column_id: &str) -> f64 {
    data.tasks
        .iter()
        .filter(|t| t.deleted_at.is_none() && t.column_id == column_id)
        .map(|t| t.position)
        .fold(0.0f64, f64::max)
}

fn live_task<'a>(data: &'a mut BoardData, id: &str) -> Result<&'a mut Task, String> {
    data.tasks.iter_mut().find(|t| t.id == id && t.deleted_at.is_none()).ok_or_else(|| "unknown task".to_string())
}

/// When any neighbor gap in the column dropped below MIN_GAP (fractional
/// indexes exhausted), renumber the whole column by STRIDE preserving order.
fn renumber_if_cramped(data: &mut BoardData, column_id: &str) {
    let mut idx: Vec<usize> = (0..data.tasks.len())
        .filter(|&i| data.tasks[i].deleted_at.is_none() && data.tasks[i].column_id == column_id)
        .collect();
    idx.sort_by(|&a, &b| data.tasks[a].position.total_cmp(&data.tasks[b].position));
    let cramped = idx.windows(2).any(|w| (data.tasks[w[1]].position - data.tasks[w[0]].position).abs() < MIN_GAP);
    if !cramped {
        return;
    }
    let now = now_ms();
    for (rank, &i) in idx.iter().enumerate() {
        data.tasks[i].position = STRIDE * (rank as f64 + 1.0);
        data.tasks[i].updated_at = now;
    }
}

// ── Tauri command surface (wrapped in src/lib/api.ts) ────────────────────

pub fn emit_changed(app: &AppHandle, store: &TaskStore) {
    let _ = app.emit("tasks:changed", store.snapshot());
}

#[tauri::command]
pub fn board_snapshot(tasks: State<TaskStore>) -> BoardSnapshot {
    tasks.snapshot()
}

#[tauri::command]
pub fn task_create(
    title: String,
    description: Option<String>,
    project_id: Option<String>,
    column_id: Option<String>,
    parent_id: Option<String>,
    app: AppHandle,
    tasks: State<TaskStore>,
) -> Result<Task, String> {
    let task = tasks.create_task(title, description, project_id, column_id, parent_id)?;
    emit_changed(&app, &tasks);
    Ok(task)
}

#[tauri::command]
pub fn task_update(task_id: String, patch: TaskPatch, app: AppHandle, tasks: State<TaskStore>) -> Result<(), String> {
    tasks.update_task(&task_id, patch)?;
    emit_changed(&app, &tasks);
    Ok(())
}

#[tauri::command]
pub fn task_delete(task_id: String, app: AppHandle, tasks: State<TaskStore>) -> Result<(), String> {
    tasks.delete_task(&task_id)?;
    emit_changed(&app, &tasks);
    Ok(())
}

#[tauri::command]
pub fn task_move(
    task_id: String,
    column_id: String,
    position: f64,
    app: AppHandle,
    tasks: State<TaskStore>,
) -> Result<(), String> {
    tasks.move_task(&task_id, &column_id, position)?;
    emit_changed(&app, &tasks);
    Ok(())
}

#[tauri::command]
pub fn task_link_workspace(
    task_id: String,
    workspace_id: String,
    app: AppHandle,
    tasks: State<TaskStore>,
) -> Result<(), String> {
    tasks.link_workspace(&task_id, &workspace_id)?;
    emit_changed(&app, &tasks);
    Ok(())
}

#[tauri::command]
pub fn board_set_estimate_unit(unit: EstimateUnit, app: AppHandle, tasks: State<TaskStore>) {
    tasks.set_estimate_unit(unit);
    emit_changed(&app, &tasks);
}

#[tauri::command]
pub fn task_activity(task_id: String, tasks: State<TaskStore>) -> Vec<ActivityEntry> {
    tasks.activity(&task_id)
}

#[tauri::command]
pub fn task_mark_done(task_id: String, app: AppHandle, tasks: State<TaskStore>) -> Result<(), String> {
    tasks.mark_done(&task_id)?;
    emit_changed(&app, &tasks);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> (TaskStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("bl-tasks-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (TaskStore::load(dir.join("tasks.json")), dir)
    }

    #[test]
    fn seeds_default_board_and_persists() {
        let (s, dir) = store("seeds_default_board_and_persists");
        let snap = s.snapshot();
        assert_eq!(snap.columns.len(), 4);
        let roles: Vec<ColumnRole> = snap.columns.iter().map(|c| c.role).collect();
        assert_eq!(roles, [ColumnRole::None, ColumnRole::Active, ColumnRole::Review, ColumnRole::Done]);

        let t = s.create_task("Ship the board".into(), None, Some("p1".into()), None, None).unwrap();
        assert_eq!(t.column_id, snap.columns[0].id, "new tasks land in the first column");

        // Reload from disk: same board, task included.
        let s2 = TaskStore::load(dir.join("tasks.json"));
        assert_eq!(s2.snapshot().tasks.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tombstones_survive_reload_but_stay_hidden() {
        let (s, dir) = store("tombstones_survive_reload_but_stay_hidden");
        let t = s.create_task("temp".into(), None, None, None, None).unwrap();
        s.delete_task(&t.id).unwrap();
        assert!(s.snapshot().tasks.is_empty());
        // Still on disk as a tombstone (future sync needs it).
        let raw = std::fs::read_to_string(dir.join("tasks.json")).unwrap();
        assert!(raw.contains(&t.id));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_renumbers_when_gaps_exhaust() {
        let (s, dir) = store("move_renumbers_when_gaps_exhaust");
        let col = s.snapshot().columns[0].id.clone();
        let a = s.create_task("a".into(), None, None, None, None).unwrap();
        let b = s.create_task("b".into(), None, None, None, None).unwrap();
        // Squeeze b into a gap smaller than MIN_GAP → renumber kicks in.
        s.move_task(&b.id, &col, a.position + MIN_GAP / 2.0).unwrap();
        let snap = s.snapshot();
        let gap = snap.tasks[1].position - snap.tasks[0].position;
        assert!(gap >= 1.0, "renumbered gap, got {gap}");
        assert_eq!(snap.tasks[0].id, a.id);
        assert_eq!(snap.tasks[1].id, b.id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lifecycle_hooks_route_by_role() {
        let (s, dir) = store("lifecycle_hooks_route_by_role");
        let active = col_id(&s, ColumnRole::Active);
        let done = col_id(&s, ColumnRole::Done);
        let t = s.create_task("task".into(), None, None, None, None).unwrap();

        s.link_workspace(&t.id, "ws1").unwrap();
        let t2 = s.snapshot().tasks[0].clone();
        assert_eq!(t2.column_id, active, "linking moves to the active column");
        assert_eq!(t2.workspace_id.as_deref(), Some("ws1"));

        assert!(s.on_workspace_done("ws1"));
        assert_eq!(s.snapshot().tasks[0].column_id, done, "merge moves to done");

        // Removal keeps the link (it keys the archived chat); the task already
        // sits in Done, so no mark-done offer.
        assert!(s.on_workspace_removed("ws1").is_none(), "already done: no mark-done offer");
        assert_eq!(
            s.snapshot().tasks[0].workspace_id.as_deref(),
            Some("ws1"),
            "link survives deletion for the chat archive"
        );
        // Archived links never eat a dispatch slot.
        assert_eq!(s.active_count(|_| false), 0);

        // A task deleted mid-flight (not in Done) gets the offer instead.
        let t2 = s.create_task("mid-flight".into(), None, None, None, None).unwrap();
        s.link_workspace(&t2.id, "ws2").unwrap();
        let offer = s.on_workspace_removed("ws2").expect("offer to mark done");
        assert_eq!(offer.title, "mid-flight");
        let snap = s.snapshot();
        let t2s = snap.tasks.iter().find(|t| t.id == t2.id).unwrap();
        assert_eq!(t2s.column_id, active, "stays in the active column until the user decides");
        s.mark_done(&t2.id).unwrap();
        assert_eq!(s.snapshot().tasks.iter().find(|t| t.id == t2.id).unwrap().column_id, done, "mark_done moves it");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn turn_gates_route_between_roles() {
        let (s, dir) = store("turn-gates");
        let todo = s.snapshot().columns[0].id.clone();
        let active = col_id(&s, ColumnRole::Active);
        let review = col_id(&s, ColumnRole::Review);

        let t = s.create_task("t".into(), Some("desc".into()), Some("p1".into()), None, None).unwrap();
        s.link_workspace(&t.id, "ws1").unwrap(); // -> active

        // Turn ends: active -> review (returns the title for the toast).
        assert_eq!(s.on_turn_ended("ws1").map(|(_, title)| title).as_deref(), Some("t"));
        assert_eq!(task_col(&s, &t.id), review);
        // Repeat is a no-op (card no longer in active).
        assert!(s.on_turn_ended("ws1").is_none());

        // New turn (feedback): review -> active.
        assert!(s.on_turn_started("ws1").is_some());
        assert_eq!(task_col(&s, &t.id), active);

        // Manual drag wins: user parks it in Todo; a turn end must not touch it.
        s.move_task(&t.id, &todo, 1.0).unwrap();
        assert!(s.on_turn_ended("ws1").is_none());
        assert_eq!(task_col(&s, &t.id), todo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn queue_dispatch_order_and_dependencies() {
        let (s, dir) = store("queue-deps");
        let queued = col_id(&s, ColumnRole::Active);

        // No queued tasks yet.
        assert!(s.next_queued().is_none());

        let a = s.create_task("a".into(), None, Some("p1".into()), Some(queued.clone()), None).unwrap();
        let b = s.create_task("b".into(), None, Some("p1".into()), Some(queued.clone()), None).unwrap();
        let no_project = s.create_task("np".into(), None, None, Some(queued.clone()), None).unwrap();
        // b depends on a: not dispatchable until a is done.
        {
            let mut data = s.data.lock().unwrap();
            data.tasks.iter_mut().find(|t| t.id == b.id).unwrap().depends_on = vec![a.id.clone()];
        }

        // Lowest position with met deps: a.
        assert_eq!(s.next_queued().unwrap().id, a.id);
        // Linking a removes it from the queue and counts toward capacity.
        s.link_workspace(&a.id, "ws-a").unwrap();
        assert_eq!(s.active_count(|_| true), 1);
        // b blocked (dep on a); project-less np is next — quick-chat dispatch.
        assert_eq!(s.next_queued().unwrap().id, no_project.id);
        s.link_workspace(&no_project.id, "ws-np").unwrap();
        // a lands in done -> b unblocks.
        s.mark_done(&a.id).unwrap();
        assert_eq!(s.next_queued().unwrap().id, b.id);
        // A tombstoned dep never deadlocks the queue.
        {
            let mut data = s.data.lock().unwrap();
            data.tasks.iter_mut().find(|t| t.id == b.id).unwrap().depends_on = vec!["gone".into(), a.id.clone()];
        }
        assert_eq!(s.next_queued().unwrap().id, b.id);
        let _ = no_project;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn subtasks_inherit_project_and_parents_never_dispatch() {
        let (s, dir) = store("subtasks");
        let active = col_id(&s, ColumnRole::Active);
        let parent = s.create_task("batch".into(), None, Some("p1".into()), Some(active.clone()), None).unwrap();
        let c1 = s.create_task("one".into(), None, None, Some(active.clone()), Some(parent.id.clone())).unwrap();
        let c2 = s.create_task("two".into(), None, None, Some(active.clone()), Some(parent.id.clone())).unwrap();
        assert_eq!(c1.project_id.as_deref(), Some("p1"), "inherits the parent's project");
        // Nesting refused.
        assert!(s.create_task("x".into(), None, None, None, Some(c1.id.clone())).is_err());
        // The parent sits queued in the active column but never dispatches;
        // its first child does.
        assert_eq!(s.next_queued().unwrap().id, c1.id);

        // A blocked-by edit chains c2 behind c1 (self/unknown ids dropped).
        let dep_patch = |deps: Vec<String>| TaskPatch { depends_on: Some(deps), ..Default::default() };
        s.update_task(&c2.id, dep_patch(vec![c1.id.clone(), c2.id.clone(), "ghost".into()])).unwrap();
        let snap = s.snapshot();
        let c2s = snap.tasks.iter().find(|t| t.id == c2.id).unwrap();
        assert_eq!(c2s.depends_on, vec![c1.id.clone()]);
        assert_eq!(s.next_queued().unwrap().id, c1.id, "c2 blocked behind c1");
        s.mark_done(&c1.id).unwrap();
        assert_eq!(s.next_queued().unwrap().id, c2.id, "chain drains in order");
        // Clearing the list unblocks.
        s.update_task(&c2.id, dep_patch(Vec::new())).unwrap();
        assert!(s.snapshot().tasks.iter().find(|t| t.id == c2.id).unwrap().depends_on.is_empty());
        // Estimates: set, then clear with a negative value.
        let est = |e: f64| TaskPatch { estimate: Some(e), ..Default::default() };
        s.update_task(&c2.id, est(2.5)).unwrap();
        assert_eq!(s.snapshot().tasks.iter().find(|t| t.id == c2.id).unwrap().estimate, Some(2.5));
        s.update_task(&c2.id, est(-1.0)).unwrap();
        assert_eq!(s.snapshot().tasks.iter().find(|t| t.id == c2.id).unwrap().estimate, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn activity_records_events_and_comments() {
        let (s, dir) = store("activity");
        let active = col_id(&s, ColumnRole::Active);
        let t = s.create_task("feed me".into(), None, None, None, None).unwrap();
        s.move_task(&t.id, &active, 100.0).unwrap();
        s.link_workspace(&t.id, "ws1").unwrap();
        s.on_turn_ended("ws1").unwrap();
        s.add_comment(&t.id, "comment", "user", "  looks good  ").unwrap();
        s.mark_done(&t.id).unwrap();
        let kinds: Vec<String> = s.activity(&t.id).iter().map(|a| a.kind.clone()).collect();
        assert_eq!(kinds, ["created", "moved", "session", "review", "comment", "done"]);
        let feed = s.activity(&t.id);
        assert_eq!(feed[4].body, "looks good", "comments are trimmed");
        assert!(s.add_comment(&t.id, "comment", "user", "   ").is_err(), "empty comment refused");
        assert!(s.activity("nope").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parent_to_active_queues_children_and_kickoff_carries_context() {
        let (s, dir) = store("cascade");
        let active = col_id(&s, ColumnRole::Active);
        let parent = s
            .create_task("Client batch".into(), Some("Fix the pilot feedback".into()), Some("p1".into()), None, None)
            .unwrap();
        let c1 = s.create_task("Research the codebase".into(), None, None, None, Some(parent.id.clone())).unwrap();
        let c2 = s.create_task("Fix rounding".into(), None, None, None, Some(parent.id.clone())).unwrap();
        s.mark_done(&c2.id).unwrap(); // done children must not be pulled back
        s.move_task(&parent.id, &active, 1024.0).unwrap();
        let snap = s.snapshot();
        let col = |id: &str| snap.tasks.iter().find(|t| t.id == id).unwrap().column_id.clone();
        assert_eq!(col(&c1.id), active, "todo child follows the parent");
        assert_ne!(col(&c2.id), active, "done child stays done");
        assert_eq!(s.next_queued().unwrap().id, c1.id, "child dispatches, parent never does");

        let c1 = snap.tasks.iter().find(|t| t.id == c1.id).unwrap();
        let (_, sent) = s.kickoff_prompt(c1, Some("proj"));
        assert!(sent.contains("SUBTASK of #1 Client batch"), "parent ref present: {sent}");
        assert!(sent.contains("Parent goal: Fix the pilot feedback"));
        assert!(sent.contains("<- YOU are this one"));
        assert!(sent.contains("#3 Fix rounding (done)"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn task_branches_are_slugged() {
        let t = |number: u64, title: &str| Task {
            id: "x".into(),
            number,
            title: title.into(),
            description: None,
            project_id: None,
            column_id: "c".into(),
            position: 0.0,
            workspace_id: None,
            parent_id: None,
            depends_on: Vec::new(),
            estimate: None,
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
        };
        assert_eq!(task_branch(&t(6, "Research the codebase")), "task/6-research-the-codebase");
        assert_eq!(task_branch(&t(9, "Fix: rounding (v2)!")), "task/9-fix-rounding-v2");
        assert_eq!(task_branch(&t(3, "***")), "task/3");
    }

    #[test]
    fn agent_writes_carry_provenance() {
        let (s, dir) = store("agent-writes");
        let t = s.create_task("host".into(), None, None, None, None).unwrap();
        assert_eq!(s.find_by_number(t.number).unwrap().id, t.id);
        assert!(s.find_by_number(999).is_none());

        s.add_comment(&t.id, "comment", "agent", "findings from #6").unwrap();
        let feed = s.activity(&t.id);
        assert_eq!(feed.last().unwrap().actor, "agent");

        let filed = s.create_task_from_agent("follow-up".into(), Some("bug".into()), Some(t.id.clone())).unwrap();
        assert_eq!(filed.parent_id.as_deref(), Some(t.id.as_str()));
        let created = s.activity(&filed.id);
        assert_eq!(created[0].kind, "created");
        assert_eq!(created[0].actor, "agent", "agent-filed tasks say so");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn numbers_are_incremental_and_backfilled() {
        let (s, dir) = store("numbers");
        let a = s.create_task("a".into(), None, None, None, None).unwrap();
        let b = s.create_task("b".into(), None, None, None, None).unwrap();
        assert_eq!((a.number, b.number), (1, 2));
        s.delete_task(&b.id).unwrap();
        // Numbers are never reused, even after tombstoning.
        assert_eq!(s.create_task("c".into(), None, None, None, None).unwrap().number, 3);

        // Pre-numbering rows (number=0) get backfilled oldest-first on load.
        {
            let mut data = s.data.lock().unwrap();
            data.tasks.iter_mut().for_each(|t| t.number = 0);
            data.next_task_number = 0;
            s.persist(&data);
        }
        let s2 = TaskStore::load(dir.join("tasks.json"));
        let snap = s2.snapshot();
        let a2 = snap.tasks.iter().find(|t| t.id == a.id).unwrap();
        assert!(a2.number > 0);
        assert_eq!(s2.create_task("d".into(), None, None, None, None).unwrap().number, 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parent_deletion_tombstones_children() {
        let (s, dir) = store("parent-del");
        let parent = s.create_task("parent".into(), None, None, None, None).unwrap();
        let child = s.create_task("child".into(), None, None, None, None).unwrap();
        {
            let mut data = s.data.lock().unwrap();
            data.tasks.iter_mut().find(|t| t.id == child.id).unwrap().parent_id = Some(parent.id.clone());
        }
        s.delete_task(&parent.id).unwrap();
        assert!(s.snapshot().tasks.is_empty(), "child tombstoned with its parent");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn col_id(s: &TaskStore, role: ColumnRole) -> String {
        s.snapshot().columns.iter().find(|c| c.role == role).unwrap().id.clone()
    }

    fn task_col(s: &TaskStore, id: &str) -> String {
        s.snapshot().tasks.iter().find(|t| t.id == id).unwrap().column_id.clone()
    }

    #[test]
    fn canonicalize_replaces_legacy_layouts() {
        let dir = std::env::temp_dir().join(format!("bl-tasks-{}-canon", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("tasks.json");
        // Hand-craft a legacy board: 5 columns incl. a queued role and a
        // custom "Icebox", with tasks spread across them.
        let legacy = serde_json::json!({
            "columns": [
                {"id": "c-todo", "name": "Todo", "role": "none", "position": 1.0, "updatedAt": 0},
                {"id": "c-q", "name": "Queued", "role": "queued", "position": 2.0, "updatedAt": 0},
                {"id": "c-a", "name": "In progress", "role": "active", "position": 3.0, "updatedAt": 0},
                {"id": "c-ice", "name": "Icebox", "role": "none", "position": 4.0, "updatedAt": 0},
                {"id": "c-d", "name": "Done", "role": "done", "position": 5.0, "updatedAt": 0}
            ],
            "tasks": [
                {"id": "t-q", "title": "queued card", "columnId": "c-q", "position": 1.0, "createdAt": 0, "updatedAt": 0},
                {"id": "t-ice", "title": "iced card", "columnId": "c-ice", "position": 1.0, "createdAt": 0, "updatedAt": 0},
                {"id": "t-d", "title": "done card", "columnId": "c-d", "position": 1.0, "createdAt": 0, "updatedAt": 0}
            ]
        });
        std::fs::write(&file, serde_json::to_string(&legacy).unwrap()).unwrap();

        let s = TaskStore::load(file);
        let snap = s.snapshot();
        assert_eq!(snap.columns.len(), 4, "canonical layout enforced");
        // Legacy queued folds into Active; customs land in Todo; done stays.
        assert_eq!(task_col(&s, "t-q"), col_id(&s, ColumnRole::Active));
        assert_eq!(task_col(&s, "t-ice"), snap.columns[0].id);
        assert_eq!(task_col(&s, "t-d"), col_id(&s, ColumnRole::Done));
        // The unlinked queued card is immediately dispatchable... except it
        // has no project — still yielded (quick-chat dispatch).
        assert_eq!(s.next_queued().unwrap().id, "t-q");
        // A canonical board loads untouched (columns keep their ids).
        let before: Vec<String> = snap.columns.iter().map(|c| c.id.clone()).collect();
        let s2 = TaskStore::load(dir.join("tasks.json"));
        let after: Vec<String> = s2.snapshot().columns.iter().map(|c| c.id.clone()).collect();
        assert_eq!(before, after, "idempotent");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
