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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ColumnRole {
    #[default]
    None,
    /// The delegation queue: the supervisor dispatches cards dropped here.
    Queued,
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
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    pub column_id: String,
    pub position: f64,
    /// Linked session; cleared when that workspace is deleted.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Subtask hierarchy (v2 UI): the main board shows only parentless tasks.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Dispatch dependencies: queued tasks wait until every dep is done.
    /// Sequential batches are chains; parallel batches have no deps.
    #[serde(default)]
    pub depends_on: Vec<String>,
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
}

/// What the frontend sees: live records only, sorted by position.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSnapshot {
    pub columns: Vec<Column>,
    pub tasks: Vec<Task>,
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
}

pub struct TaskStore {
    data: Mutex<BoardData>,
    file: PathBuf,
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
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
        if !data.columns.iter().any(|c| c.deleted_at.is_none()) {
            seed_default_columns(&mut data);
        }
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
        BoardSnapshot { columns, tasks }
    }

    pub fn create_task(
        &self,
        title: String,
        description: Option<String>,
        project_id: Option<String>,
        column_id: Option<String>,
    ) -> Result<Task, String> {
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err("task title is empty".into());
        }
        let mut data = self.data.lock().unwrap();
        let column_id = match column_id {
            Some(id) if data.columns.iter().any(|c| c.id == id && c.deleted_at.is_none()) => id,
            Some(_) => return Err("unknown column".into()),
            None => first_column(&data).ok_or("board has no columns")?,
        };
        let position = max_position(&data, &column_id) + STRIDE;
        let now = now_ms();
        let task = Task {
            id: new_id(),
            title,
            description: normalize(description),
            project_id: normalize(project_id),
            column_id,
            position,
            workspace_id: None,
            parent_id: None,
            depends_on: Vec::new(),
            created_at: now,
            updated_at: now,
            deleted_at: None,
        };
        data.tasks.push(task.clone());
        self.persist(&data);
        Ok(task)
    }

    pub fn update_task(&self, id: &str, patch: TaskPatch) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
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
        {
            let task = live_task(&mut data, id)?;
            task.column_id = column_id.to_string();
            task.position = position;
            task.updated_at = now_ms();
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
        self.persist(&data);
        true
    }

    /// The linked workspace was deleted: only clear the link (the id would
    /// dangle) — deletion is not proof the work landed, so nothing moves.
    /// Returns the task so the UI can OFFER "mark as done"; suppressed when
    /// the task already sits in the done column (e.g. merge moved it first).
    pub fn on_workspace_removed(&self, workspace_id: &str) -> Option<UnlinkedTask> {
        let mut data = self.data.lock().unwrap();
        let done = role_column(&data, ColumnRole::Done);
        let task = data
            .tasks
            .iter_mut()
            .find(|t| t.deleted_at.is_none() && t.workspace_id.as_deref() == Some(workspace_id))?;
        task.workspace_id = None;
        task.updated_at = now_ms();
        let offer = (done.as_deref() != Some(task.column_id.as_str()))
            .then(|| UnlinkedTask { task_id: task.id.clone(), title: task.title.clone() });
        self.persist(&data);
        offer
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
        }
        task.updated_at = now_ms();
        self.persist(&data);
        Ok(())
    }

    // ── Workflow machine hooks (called by the supervisor) ───────────────────

    /// A linked session's turn finished: park the card in the review column —
    /// but only if it currently sits in the active column, so the user's
    /// manual placement always wins. Returns the task title on a move.
    pub fn on_turn_ended(&self, workspace_id: &str) -> Option<String> {
        self.move_between_roles(workspace_id, ColumnRole::Active, ColumnRole::Review)
    }

    /// A linked session started a new turn (feedback, composer message,
    /// autofix — any): pull the card from review back to active.
    pub fn on_turn_started(&self, workspace_id: &str) -> Option<String> {
        self.move_between_roles(workspace_id, ColumnRole::Review, ColumnRole::Active)
    }

    fn move_between_roles(&self, workspace_id: &str, from: ColumnRole, to: ColumnRole) -> Option<String> {
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
        let title = task.title.clone();
        self.persist(&data);
        Some(title)
    }

    /// The next dispatchable card in the queued column: lowest position, has
    /// a project, not linked yet, and every dependency already sits in the
    /// done column (missing/tombstoned deps count as satisfied — a deleted
    /// dep must never deadlock the queue).
    pub fn next_queued(&self) -> Option<Task> {
        let data = self.data.lock().unwrap();
        let queued = role_column(&data, ColumnRole::Queued)?;
        let done = role_column(&data, ColumnRole::Done);
        let dep_done = |dep: &String| {
            data.tasks
                .iter()
                .find(|t| &t.id == dep && t.deleted_at.is_none())
                .is_none_or(|t| Some(t.column_id.as_str()) == done.as_deref())
        };
        data.tasks
            .iter()
            .filter(|t| {
                t.deleted_at.is_none()
                    && t.column_id == queued
                    && t.project_id.is_some()
                    && t.workspace_id.is_none()
                    && t.depends_on.iter().all(dep_done)
            })
            .min_by(|a, b| a.position.total_cmp(&b.position))
            .cloned()
    }

    /// Linked cards currently in the active column — the dispatch capacity
    /// measure (each represents an agent session this machine started or
    /// adopted).
    pub fn active_count(&self) -> usize {
        let data = self.data.lock().unwrap();
        let Some(active) = role_column(&data, ColumnRole::Active) else { return 0 };
        data.tasks
            .iter()
            .filter(|t| t.deleted_at.is_none() && t.column_id == active && t.workspace_id.is_some())
            .count()
    }

    pub fn create_column(&self, name: String) -> Result<Column, String> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("column name is empty".into());
        }
        let mut data = self.data.lock().unwrap();
        let position =
            data.columns.iter().filter(|c| c.deleted_at.is_none()).map(|c| c.position).fold(0.0f64, f64::max) + STRIDE;
        let col =
            Column { id: new_id(), name, role: ColumnRole::None, position, updated_at: now_ms(), deleted_at: None };
        data.columns.push(col.clone());
        self.persist(&data);
        Ok(col)
    }

    /// Rename and/or re-role a column. Assigning `active`/`done` steals the
    /// role from any column that held it (at most one column per role).
    pub fn update_column(&self, id: &str, name: Option<String>, role: Option<ColumnRole>) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
        if !data.columns.iter().any(|c| c.id == id && c.deleted_at.is_none()) {
            return Err("unknown column".into());
        }
        let now = now_ms();
        if let Some(role) = role {
            if role != ColumnRole::None {
                for c in data.columns.iter_mut().filter(|c| c.role == role && c.id != id) {
                    c.role = ColumnRole::None;
                    c.updated_at = now;
                }
            }
        }
        let col = data.columns.iter_mut().find(|c| c.id == id).unwrap();
        if let Some(name) = name {
            let name = name.trim().to_string();
            if name.is_empty() {
                return Err("column name is empty".into());
            }
            col.name = name;
        }
        if let Some(role) = role {
            col.role = role;
        }
        col.updated_at = now;
        self.persist(&data);
        Ok(())
    }

    pub fn move_column(&self, id: &str, position: f64) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
        let col = data.columns.iter_mut().find(|c| c.id == id && c.deleted_at.is_none()).ok_or("unknown column")?;
        col.position = position;
        col.updated_at = now_ms();
        self.persist(&data);
        Ok(())
    }

    /// Replace the current columns with the default workflow scaffold,
    /// preserving every task: cards follow their column's ROLE to the new
    /// layout (active stays active, …); role-less columns' cards land in Todo.
    pub fn reset_columns(&self) {
        let mut data = self.data.lock().unwrap();
        let now = now_ms();
        // Old column id -> its role, before tombstoning.
        let old_roles: std::collections::HashMap<String, ColumnRole> =
            data.columns.iter().filter(|c| c.deleted_at.is_none()).map(|c| (c.id.clone(), c.role)).collect();
        for c in data.columns.iter_mut().filter(|c| c.deleted_at.is_none()) {
            c.deleted_at = Some(now);
            c.updated_at = now;
        }
        seed_default_columns(&mut data);
        let by_role: std::collections::HashMap<ColumnRole, String> =
            data.columns.iter().filter(|c| c.deleted_at.is_none()).map(|c| (c.role, c.id.clone())).collect();
        let todo = data.columns.iter().find(|c| c.deleted_at.is_none()).map(|c| c.id.clone()).unwrap();
        for t in data.tasks.iter_mut().filter(|t| t.deleted_at.is_none()) {
            let role = old_roles.get(&t.column_id).copied().unwrap_or(ColumnRole::None);
            t.column_id = by_role.get(&role).cloned().unwrap_or_else(|| todo.clone());
            t.updated_at = now;
        }
        self.persist(&data);
    }

    /// Refused while the column still holds live tasks — the UI moves them
    /// first, so nothing is ever deleted implicitly.
    pub fn delete_column(&self, id: &str) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
        if data.tasks.iter().any(|t| t.deleted_at.is_none() && t.column_id == id) {
            return Err("column still contains tasks".into());
        }
        let now = now_ms();
        let col = data.columns.iter_mut().find(|c| c.id == id && c.deleted_at.is_none()).ok_or("unknown column")?;
        col.deleted_at = Some(now);
        col.updated_at = now;
        self.persist(&data);
        Ok(())
    }
}

/// The scaffolded workflow: every role assigned out of the box.
const DEFAULT_COLUMNS: [(&str, ColumnRole); 5] = [
    ("Todo", ColumnRole::None),
    ("Queued", ColumnRole::Queued),
    ("In progress", ColumnRole::Active),
    ("Needs review", ColumnRole::Review),
    ("Done", ColumnRole::Done),
];

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

/// The prompt a task-dispatched session opens with: `display` is the readable
/// task text shown in the transcript; `sent` carries the structured context
/// block so the agent can see every task property.
pub fn task_prompt(task: &Task, project_name: Option<&str>) -> (String, String) {
    let display = match &task.description {
        Some(d) => format!("{}\n\n{}", task.title, d),
        None => task.title.clone(),
    };
    let mut sent = display.clone();
    sent.push_str("\n\n---\nTask context (from the BranchLab board):\n");
    sent.push_str(&format!("- Title: {}\n", task.title));
    if let Some(p) = project_name {
        sent.push_str(&format!("- Project: {p}\n"));
    }
    sent.push_str(&format!("- Task id: {}\n", task.id));
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

fn emit_changed(app: &AppHandle, store: &TaskStore) {
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
    app: AppHandle,
    tasks: State<TaskStore>,
) -> Result<Task, String> {
    let task = tasks.create_task(title, description, project_id, column_id)?;
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
pub fn task_mark_done(task_id: String, app: AppHandle, tasks: State<TaskStore>) -> Result<(), String> {
    tasks.mark_done(&task_id)?;
    emit_changed(&app, &tasks);
    Ok(())
}

#[tauri::command]
pub fn column_create(name: String, app: AppHandle, tasks: State<TaskStore>) -> Result<Column, String> {
    let col = tasks.create_column(name)?;
    emit_changed(&app, &tasks);
    Ok(col)
}

#[tauri::command]
pub fn column_update(
    column_id: String,
    name: Option<String>,
    role: Option<ColumnRole>,
    app: AppHandle,
    tasks: State<TaskStore>,
) -> Result<(), String> {
    tasks.update_column(&column_id, name, role)?;
    emit_changed(&app, &tasks);
    Ok(())
}

#[tauri::command]
pub fn column_move(column_id: String, position: f64, app: AppHandle, tasks: State<TaskStore>) -> Result<(), String> {
    tasks.move_column(&column_id, position)?;
    emit_changed(&app, &tasks);
    Ok(())
}

#[tauri::command]
pub fn column_reset(app: AppHandle, tasks: State<TaskStore>) {
    tasks.reset_columns();
    emit_changed(&app, &tasks);
}

#[tauri::command]
pub fn column_delete(column_id: String, app: AppHandle, tasks: State<TaskStore>) -> Result<(), String> {
    tasks.delete_column(&column_id)?;
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
        assert_eq!(snap.columns.len(), 5);
        let roles: Vec<ColumnRole> = snap.columns.iter().map(|c| c.role).collect();
        assert_eq!(
            roles,
            [ColumnRole::None, ColumnRole::Queued, ColumnRole::Active, ColumnRole::Review, ColumnRole::Done]
        );

        let t = s.create_task("Ship the board".into(), None, Some("p1".into()), None).unwrap();
        assert_eq!(t.column_id, snap.columns[0].id, "new tasks land in the first column");

        // Reload from disk: same board, task included.
        let s2 = TaskStore::load(dir.join("tasks.json"));
        assert_eq!(s2.snapshot().tasks.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tombstones_survive_reload_but_stay_hidden() {
        let (s, dir) = store("tombstones_survive_reload_but_stay_hidden");
        let t = s.create_task("temp".into(), None, None, None).unwrap();
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
        let a = s.create_task("a".into(), None, None, None).unwrap();
        let b = s.create_task("b".into(), None, None, None).unwrap();
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
        let t = s.create_task("task".into(), None, None, None).unwrap();

        s.link_workspace(&t.id, "ws1").unwrap();
        let t2 = s.snapshot().tasks[0].clone();
        assert_eq!(t2.column_id, active, "linking moves to the active column");
        assert_eq!(t2.workspace_id.as_deref(), Some("ws1"));

        assert!(s.on_workspace_done("ws1"));
        assert_eq!(s.snapshot().tasks[0].column_id, done, "merge moves to done");

        // Removal only unlinks; the task already sits in Done, so no offer.
        assert!(s.on_workspace_removed("ws1").is_none(), "already done: no mark-done offer");
        assert_eq!(s.snapshot().tasks[0].workspace_id, None, "deletion clears the link");
        assert!(s.on_workspace_removed("ws1").is_none(), "no linked task left");

        // A task deleted mid-flight (not in Done) gets the offer instead.
        let t2 = s.create_task("mid-flight".into(), None, None, None).unwrap();
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

        let t = s.create_task("t".into(), Some("desc".into()), Some("p1".into()), None).unwrap();
        s.link_workspace(&t.id, "ws1").unwrap(); // -> active

        // Turn ends: active -> review (returns the title for the toast).
        assert_eq!(s.on_turn_ended("ws1").as_deref(), Some("t"));
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
        let queued = col_id(&s, ColumnRole::Queued);

        // No queued tasks yet.
        assert!(s.next_queued().is_none());

        let a = s.create_task("a".into(), None, Some("p1".into()), Some(queued.clone())).unwrap();
        let b = s.create_task("b".into(), None, Some("p1".into()), Some(queued.clone())).unwrap();
        let no_project = s.create_task("np".into(), None, None, Some(queued.clone())).unwrap();
        // b depends on a: not dispatchable until a is done.
        {
            let mut data = s.data.lock().unwrap();
            data.tasks.iter_mut().find(|t| t.id == b.id).unwrap().depends_on = vec![a.id.clone()];
        }

        // Lowest position with project and met deps: a.
        assert_eq!(s.next_queued().unwrap().id, a.id);
        // Linking a removes it from the queue and counts toward capacity.
        s.link_workspace(&a.id, "ws-a").unwrap();
        assert_eq!(s.active_count(), 1);
        // b still blocked (a not done); np skipped (no project).
        assert!(s.next_queued().is_none());
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
    fn parent_deletion_tombstones_children() {
        let (s, dir) = store("parent-del");
        let parent = s.create_task("parent".into(), None, None, None).unwrap();
        let child = s.create_task("child".into(), None, None, None).unwrap();
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
    fn column_rules() {
        let (s, dir) = store("column_rules");
        let cols = s.snapshot().columns;
        // Role steal: assigning Done to another column clears the old one.
        let c = s.create_column("Shipped".into()).unwrap();
        s.update_column(&c.id, None, Some(ColumnRole::Done)).unwrap();
        let snap = s.snapshot();
        assert_eq!(snap.columns.iter().filter(|c| c.role == ColumnRole::Done).count(), 1);
        assert_eq!(snap.columns.iter().find(|x| x.id == c.id).unwrap().role, ColumnRole::Done);

        // Delete guard: refuse while tasks remain.
        let t = s.create_task("x".into(), None, None, Some(cols[0].id.clone())).unwrap();
        assert!(s.delete_column(&cols[0].id).is_err());
        s.move_task(&t.id, &cols[1].id, 1.0).unwrap();
        s.delete_column(&cols[0].id).unwrap();
        assert_eq!(s.snapshot().columns.len(), 5, "6 minus the deleted one");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reset_columns_remaps_tasks_by_role() {
        let (s, dir) = store("reset-columns");
        // Custom layout: rename a column, add an extra, park tasks around.
        let active = col_id(&s, ColumnRole::Active);
        let extra = s.create_column("Icebox".into()).unwrap();
        let t_active = s.create_task("working".into(), None, None, Some(active.clone())).unwrap();
        let t_extra = s.create_task("frozen".into(), None, None, Some(extra.id.clone())).unwrap();

        s.reset_columns();
        let snap = s.snapshot();
        assert_eq!(snap.columns.len(), 5, "back to the default scaffold");
        // Role carried over; role-less landed in Todo (first column).
        assert_eq!(task_col(&s, &t_active.id), col_id(&s, ColumnRole::Active));
        assert_eq!(task_col(&s, &t_extra.id), snap.columns[0].id);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
