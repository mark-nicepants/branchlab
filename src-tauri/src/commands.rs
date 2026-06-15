//! Tauri command surface — the IPC boundary the frontend calls.

use std::path::PathBuf;

use tauri::State;

use crate::config::{self, ConfigFile};
use crate::git::{self, DiffStat, FileChange, FileContent};
use crate::project::{ProjectView, Registry, Workspace};
use crate::server::{ServerInfo, ServerManager};

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
    registry: State<Registry>,
) -> Result<Workspace, String> {
    registry.create_workspace(&project_id, base)
}

/// Remove a worktree workspace: stop its server first, then remove the worktree.
#[tauri::command]
pub fn remove_workspace(
    workspace_id: String,
    force: bool,
    registry: State<Registry>,
    servers: State<ServerManager>,
) -> Result<(), String> {
    servers.stop(&workspace_id);
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
    let repo = registry.workspace_path(&workspace_id).ok_or("unknown workspace")?;
    git::read_file(&repo, &file)
}

/// Discard a file's local changes (restore to HEAD, or delete if untracked).
#[tauri::command]
pub fn discard_file(workspace_id: String, file: String, registry: State<Registry>) -> Result<(), String> {
    let repo = registry.workspace_path(&workspace_id).ok_or("unknown workspace")?;
    git::discard_file(&repo, &file)
}

#[tauri::command]
pub fn start_server(
    workspace_id: String,
    registry: State<Registry>,
    servers: State<ServerManager>,
) -> Result<ServerInfo, String> {
    let path = registry.workspace_path(&workspace_id).ok_or_else(|| format!("unknown workspace: {workspace_id}"))?;
    servers.start(&workspace_id, &path)
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
    let path = registry.workspace_path(&workspace_id).ok_or_else(|| format!("unknown workspace: {workspace_id}"))?;
    servers.start(&workspace_id, &path)
}

// ── Config & internals ──

fn config_dir(scope: &str, workspace_id: Option<String>, registry: &Registry) -> Result<PathBuf, String> {
    match scope {
        "global" => Ok(config::global_dir()),
        "project" => {
            let id = workspace_id.ok_or("workspace id required for project config")?;
            let path = registry.workspace_path(&id).ok_or("unknown workspace")?;
            Ok(PathBuf::from(path))
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
