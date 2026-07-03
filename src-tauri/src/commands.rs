//! Tauri command surface — the IPC boundary the frontend calls.

use std::path::PathBuf;

use tauri::State;

use crate::config::{self, ConfigFile};
use crate::git::{self, DiffStat, FileChange, FileContent, PrStatus, RemoteInfo};
use crate::project::{AutofixMode, ProjectView, Registry, Workspace};
use crate::server::{ServerInfo, ServerManager};
use crate::supervisor::Supervisor;
use crate::watcher::GitWatcher;

/// Look up a workspace path, returning a uniform "unknown workspace" error.
/// Used by every command that takes a workspace_id and operates on its path.
fn with_workspace_path<T>(
    registry: &Registry,
    workspace_id: &str,
    f: impl FnOnce(&str) -> Result<T, String>,
) -> Result<T, String> {
    let path = registry.workspace_path(workspace_id).ok_or("unknown workspace")?;
    f(&path)
}

#[tauri::command]
pub fn add_project(path: String, registry: State<Registry>) -> Result<ProjectView, String> {
    registry.add_project(&path)
}

#[tauri::command]
pub fn list_projects(registry: State<Registry>) -> Vec<ProjectView> {
    registry.list()
}

#[tauri::command]
pub fn remove_project(project_id: String, registry: State<Registry>) {
    registry.remove_project(&project_id);
}

#[tauri::command]
pub fn list_branches(project_id: String, registry: State<Registry>) -> Result<Vec<String>, String> {
    registry.branches(&project_id)
}

/// Create a workspace (worktree on a generated branch codename). `base` is
/// optional — omit to fork from the repo's current branch.
#[tauri::command]
pub fn create_workspace(
    project_id: String,
    base: Option<String>,
    init_prompt: Option<String>,
    registry: State<Registry>,
    watcher: State<GitWatcher>,
    supervisor: State<Supervisor>,
) -> Result<Workspace, String> {
    let ws = registry.create_workspace(&project_id, base, init_prompt)?;
    watcher.watch(&ws.id, &ws.path);
    supervisor.reconcile_now();
    Ok(ws)
}

#[tauri::command]
pub fn update_project(
    project_id: String,
    update: crate::project::ProjectUpdate,
    registry: State<Registry>,
) -> Result<ProjectView, String> {
    registry.update_project(&project_id, update)
}

#[tauri::command]
pub fn get_project_prompts(
    project_id: String,
    registry: State<Registry>,
) -> Result<crate::project::ProjectPrompts, String> {
    registry.prompts(&project_id)
}

/// Remove a workspace: stop its server first. For worktree workspaces the git
/// worktree is also removed; for base workspaces only the registry entry is
/// deleted and the repo directory is left untouched.
#[tauri::command]
pub fn remove_workspace(
    workspace_id: String,
    force: bool,
    registry: State<Registry>,
    servers: State<ServerManager>,
    watcher: State<GitWatcher>,
) -> Result<(), String> {
    servers.stop(&workspace_id);
    watcher.unwatch(&workspace_id);
    registry.remove_workspace(&workspace_id, force)
}

#[tauri::command]
pub fn list_workspaces(registry: State<Registry>) -> Vec<Workspace> {
    registry.all_workspaces()
}

#[tauri::command]
pub fn rename_workspace(workspace_id: String, name: String, registry: State<Registry>) {
    registry.rename_workspace(&workspace_id, &name);
}

#[tauri::command]
pub fn workspace_diff_stat(workspace_id: String, registry: State<Registry>) -> DiffStat {
    match registry.workspace_path(&workspace_id) {
        Some(path) => git::diff_stat(&path),
        None => DiffStat::default(),
    }
}

/// Changed files for the diff panel. `against` defaults to HEAD (local working
/// tree); pass a base branch to compare against it instead.
#[tauri::command]
pub fn workspace_changes(workspace_id: String, against: Option<String>, registry: State<Registry>) -> Vec<FileChange> {
    match registry.workspace_path(&workspace_id) {
        Some(path) => git::changes(&path, against.as_deref().unwrap_or("HEAD")),
        None => vec![],
    }
}

/// Unified diff for one file in a workspace.
#[tauri::command]
pub fn workspace_file_diff(
    workspace_id: String,
    file: String,
    against: Option<String>,
    registry: State<Registry>,
) -> String {
    match registry.workspace_path(&workspace_id) {
        Some(path) => git::file_diff(&path, &file, against.as_deref().unwrap_or("HEAD")),
        None => String::new(),
    }
}

/// All files in a workspace (tracked + untracked) for the file-tree browser.
#[tauri::command]
pub fn workspace_files(workspace_id: String, registry: State<Registry>) -> Vec<String> {
    match registry.workspace_path(&workspace_id) {
        Some(path) => git::list_files(&path),
        None => vec![],
    }
}

/// Read a file's contents from a workspace for the in-app viewer.
#[tauri::command]
pub fn read_file(workspace_id: String, file: String, registry: State<Registry>) -> Result<FileContent, String> {
    with_workspace_path(&registry, &workspace_id, |repo| git::read_file(repo, &file))
}

/// Discard a file's local changes (restore to HEAD, or delete if untracked).
#[tauri::command]
pub fn discard_file(
    workspace_id: String,
    file: String,
    registry: State<Registry>,
    watcher: State<GitWatcher>,
) -> Result<(), String> {
    let result = with_workspace_path(&registry, &workspace_id, |repo| git::discard_file(repo, &file));
    watcher.refresh(&workspace_id);
    result
}

// ── Workspace lifecycle: commit, merge, push, PR ──

#[derive(Debug, Clone, serde::Serialize)]
pub struct MergeResult {
    pub branch: String,
    pub base: String,
    pub summary: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PushResult {
    pub branch: String,
    pub remote: String,
    pub output: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PrResult {
    pub branch: String,
    pub base: String,
    pub url: String,
}

fn resolve_workspace_branch(
    registry: &Registry,
    workspace_id: &str,
) -> Result<(Workspace, String, String, String), String> {
    let (ws, root) = registry.workspace_with_root(workspace_id).ok_or("unknown workspace")?;
    let branch = ws.branch.clone().ok_or("workspace has no branch")?;
    let base = ws.base_branch.clone().unwrap_or_else(|| "main".to_string());
    Ok((ws, root, branch, base))
}

/// Commit all changes in the workspace. Fails if there is nothing staged.
#[tauri::command]
pub fn commit_workspace(workspace_id: String, message: String, registry: State<Registry>) -> Result<String, String> {
    with_workspace_path(&registry, &workspace_id, |path| git::commit_all(path, &message))
}

/// Merge the workspace branch into its base branch in the parent repo.
#[tauri::command]
pub fn merge_workspace(workspace_id: String, registry: State<Registry>) -> Result<MergeResult, String> {
    let (_ws, root, branch, base) = resolve_workspace_branch(&registry, &workspace_id)?;
    let summary = git::merge_into_base(&root, &branch, &base)?;
    Ok(MergeResult { branch, base, summary })
}

/// Push the workspace branch to `origin`.
#[tauri::command]
pub fn push_workspace(workspace_id: String, registry: State<Registry>) -> Result<PushResult, String> {
    let (_ws, root, branch, _base) = resolve_workspace_branch(&registry, &workspace_id)?;
    git::push_branch(&root, "origin", &branch).map(|output| PushResult { branch, remote: "origin".to_string(), output })
}

/// Push the branch and open a GitHub PR. Uses `gh`; must be installed and authenticated.
#[tauri::command]
pub fn create_workspace_pr(
    workspace_id: String,
    title: String,
    body: String,
    registry: State<Registry>,
) -> Result<PrResult, String> {
    let (_ws, root, branch, base) = resolve_workspace_branch(&registry, &workspace_id)?;
    let url = git::create_pull_request(&root, &branch, &base, &title, &body)?;
    Ok(PrResult { branch, base, url })
}

/// Fetch the pull-request CI status for the workspace's branch (via `gh`).
/// `Ok(None)` means the branch has no PR yet; `Err` means `gh` is unavailable
/// or the repo has no GitHub remote.
#[tauri::command]
pub fn workspace_pr_status(workspace_id: String, registry: State<Registry>) -> Result<Option<PrStatus>, String> {
    let (_ws, root, branch, _base) = resolve_workspace_branch(&registry, &workspace_id)?;
    git::pr_status(&root, &branch)
}

// ── Backend orchestration surface (see supervisor.rs / watcher.rs) ──

/// Record the OpenCode session id the frontend created/loaded for a workspace,
/// so the supervisor drives autofix through that same session (fixes stream
/// into the visible chat). Persisted in the registry for background use.
#[tauri::command]
pub fn register_session(
    workspace_id: String,
    session_id: String,
    registry: State<Registry>,
    supervisor: State<Supervisor>,
) {
    registry.set_session_id(&workspace_id, &session_id);
    supervisor.on_session_registered(&workspace_id, &session_id);
}

/// Tell the backend which workspace is on screen. The active workspace also
/// gets the full `changes` list + todos, and is always driven.
#[tauri::command]
pub fn set_active_workspace(workspace_id: Option<String>, watcher: State<GitWatcher>, supervisor: State<Supervisor>) {
    watcher.set_active(workspace_id.clone());
    supervisor.set_active(workspace_id);
}

/// Set a workspace's PR autofix mode (off|auto|super); reconciles immediately
/// so enabling it starts (and disabling stops) background driving now.
#[tauri::command]
pub fn set_autofix_mode(
    workspace_id: String,
    mode: AutofixMode,
    registry: State<Registry>,
    supervisor: State<Supervisor>,
) {
    registry.set_autofix_mode(&workspace_id, mode);
    supervisor.note_autofix_mode(&workspace_id, mode);
}

/// Force the backend to re-emit current git/session/pr snapshots. The frontend
/// calls this once after attaching its event listeners, since Tauri events are
/// not buffered for late subscribers.
#[tauri::command]
pub fn resync(watcher: State<GitWatcher>, supervisor: State<Supervisor>) {
    watcher.resync();
    supervisor.resync();
}

/// Force a git recompute + emit for one workspace (used by `refreshChanges`).
#[tauri::command]
pub fn request_git_refresh(workspace_id: String, watcher: State<GitWatcher>) {
    watcher.refresh(&workspace_id);
}

#[tauri::command]
pub fn list_remotes(workspace_id: String, registry: State<Registry>) -> Result<Vec<RemoteInfo>, String> {
    let root = registry.workspace_project_root(&workspace_id).ok_or("unknown workspace")?;
    git::list_remotes(&root)
}

#[tauri::command]
pub fn start_server(
    workspace_id: String,
    registry: State<Registry>,
    servers: State<ServerManager>,
) -> Result<ServerInfo, String> {
    with_workspace_path(&registry, &workspace_id, |path| servers.start(&workspace_id, path))
}

#[tauri::command]
pub fn stop_server(workspace_id: String, servers: State<ServerManager>) {
    servers.stop(&workspace_id);
}

#[tauri::command]
pub fn server_status(workspace_id: String, servers: State<ServerManager>) -> Option<ServerInfo> {
    servers.status(&workspace_id)
}

/// Info for every running server (drives the fleet dashboard).
#[tauri::command]
pub fn list_servers(servers: State<ServerManager>) -> Vec<ServerInfo> {
    servers.list()
}

/// Heartbeat from the UI to defer idle reaping of the active workspace.
#[tauri::command]
pub fn touch_server(workspace_id: String, servers: State<ServerManager>) {
    servers.touch(&workspace_id);
}

/// Restart a workspace's server (used after editing config to apply it).
#[tauri::command]
pub fn restart_server(
    workspace_id: String,
    registry: State<Registry>,
    servers: State<ServerManager>,
) -> Result<ServerInfo, String> {
    servers.stop(&workspace_id);
    with_workspace_path(&registry, &workspace_id, |path| servers.start(&workspace_id, path))
}

// ── Config & internals ──

fn config_dir(scope: &str, workspace_id: Option<String>, registry: &Registry) -> Result<PathBuf, String> {
    match scope {
        "global" => Ok(config::global_dir()),
        "project" => {
            let id = workspace_id.ok_or("workspace id required for project config")?;
            with_workspace_path(registry, &id, |path| Ok(PathBuf::from(path)))
        }
        _ => Err(format!("unknown config scope: {scope}")),
    }
}

/// Read the global or project opencode config file.
#[tauri::command]
pub fn read_config(
    scope: String,
    workspace_id: Option<String>,
    registry: State<Registry>,
) -> Result<ConfigFile, String> {
    Ok(config::read(&config_dir(&scope, workspace_id, &registry)?))
}

/// Write the global or project opencode config file. Returns the written path.
#[tauri::command]
pub fn write_config(
    scope: String,
    workspace_id: Option<String>,
    content: String,
    registry: State<Registry>,
) -> Result<String, String> {
    config::write(&config_dir(&scope, workspace_id, &registry)?, &content)
}

/// Open the webview inspector (we disable the default right-click menu, so this
/// is bound to a keyboard shortcut instead). Available because the tauri
/// `devtools` feature is enabled in Cargo.toml.
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// Open a path in an external app. `app` is a macOS application name for
/// `open -a` (e.g. "Terminal", "Visual Studio Code"); omit it to reveal the
/// path in Finder. (Windows/Linux equivalents land with the portability pass.)
// macOS-only: shells out to `open`. Needs `#[cfg(target_os = "macos")]` plus
// Windows/Linux branches before this can ship cross-platform.
#[tauri::command]
pub fn open_external(path: String, app: Option<String>) -> Result<(), String> {
    use std::process::Command;
    let mut cmd = Command::new("open");
    if let Some(app) = app {
        cmd.arg("-a").arg(app);
    }
    cmd.arg(&path);
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}
