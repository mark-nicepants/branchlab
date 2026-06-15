//! Tauri command surface — the IPC boundary the frontend calls.

use tauri::State;

use crate::git::{self, DiffStat};
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

#[tauri::command]
pub fn start_server(
    workspace_id: String,
    registry: State<Registry>,
    servers: State<ServerManager>,
) -> Result<ServerInfo, String> {
    let path = registry
        .workspace_path(&workspace_id)
        .ok_or_else(|| format!("unknown workspace: {workspace_id}"))?;
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
