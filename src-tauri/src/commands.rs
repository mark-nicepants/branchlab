//! Tauri command surface — the IPC boundary the frontend calls.

use std::path::PathBuf;

use tauri::State;

use crate::android::{AndroidManager, AndroidState};
use crate::config::{self, ConfigFile};
use crate::engine::opencode_http::{self, ToolsStatus};
use crate::git::{self, DiffStat, FileChange, FileContent, PrStatus, RemoteInfo};
use crate::project::{AutofixMode, ProjectType, ProjectView, Registry, Workspace};
use crate::run::{RunManager, RunSnapshot};
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
#[allow(clippy::too_many_arguments)]
pub fn create_workspace(
    project_id: String,
    base: Option<String>,
    init_prompt: Option<String>,
    registry: State<Registry>,
    watcher: State<GitWatcher>,
    supervisor: State<Supervisor>,
    runs: State<RunManager>,
    telemetry: State<crate::telemetry::Telemetry>,
) -> Result<Workspace, String> {
    let ws = registry.create_workspace(&project_id, base, init_prompt)?;
    watcher.watch(&ws.id, &ws.path);
    supervisor.reconcile_now();
    run_setup_if_configured(&registry, &runs, &ws.id);
    telemetry.event("session_created", "/session", Some(serde_json::json!({ "source": "branch" })));
    Ok(ws)
}

/// Kick off the project's setup script in a fresh worktree (non-blocking).
fn run_setup_if_configured(registry: &Registry, runs: &RunManager, workspace_id: &str) {
    let Some((ws, settings, root)) = registry.run_context(workspace_id) else { return };
    if let Some(script) = settings.setup_script.filter(|s| !s.trim().is_empty()) {
        runs.run_setup(&ws.id, &script, &ws.path, &root);
    }
}

/// Create a context-free quick chat: an app-managed scratch directory with its
/// own opencode server, but no git repo or project. Not registered with the
/// git watcher — there is nothing to diff.
#[tauri::command]
pub fn create_quick_chat(
    init_prompt: Option<String>,
    registry: State<Registry>,
    supervisor: State<Supervisor>,
    telemetry: State<crate::telemetry::Telemetry>,
) -> Result<Workspace, String> {
    let ws = registry.create_quick_chat(init_prompt)?;
    supervisor.reconcile_now();
    telemetry.event("session_created", "/session", Some(serde_json::json!({ "source": "quick_chat" })));
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

/// Open PRs for a project (yours + review-requested + assigned), for the
/// "create workspace from PR" picker. Routed through the repo's bound account.
#[tauri::command]
pub async fn list_project_prs(
    project_id: String,
    registry: State<'_, Registry>,
    github: State<'_, crate::github::GithubManager>,
) -> Result<Vec<crate::github::model::PrSummary>, String> {
    let root = registry.project_root(&project_id).ok_or("unknown project")?;
    let override_id = registry.project_account_id(&project_id);
    let (account, owner, repo) = github.resolve_account(&root, override_id.as_deref())?;
    let client = github.client_for(&account.id)?;
    client.list_open_prs(&owner, &repo).await
}

/// Check a PR out into a fresh worktree and register it as a workspace.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_workspace_from_pr(
    project_id: String,
    pr_number: i64,
    registry: State<'_, Registry>,
    github: State<'_, crate::github::GithubManager>,
    watcher: State<'_, GitWatcher>,
    supervisor: State<'_, Supervisor>,
    runs: State<'_, RunManager>,
    telemetry: State<'_, crate::telemetry::Telemetry>,
) -> Result<Workspace, String> {
    let root = registry.project_root(&project_id).ok_or("unknown project")?;
    let override_id = registry.project_account_id(&project_id);
    let (account, owner, repo) = github.resolve_account(&root, override_id.as_deref())?;
    let client = github.client_for(&account.id)?;
    let detail = client.pr_detail(&owner, &repo, pr_number).await?;

    let title = if detail.title.is_empty() { format!("PR #{pr_number}") } else { detail.title.clone() };
    let head_repo = if detail.is_fork { None } else { Some(detail.repo.clone()) };
    let meta = crate::project::PrWorkspaceMeta {
        number: pr_number,
        title,
        base_ref: detail.base_ref,
        url: detail.url,
        head_repo,
        is_fork: detail.is_fork,
    };
    let ws = registry.create_workspace_from_pr(&project_id, meta)?;
    watcher.watch(&ws.id, &ws.path);
    supervisor.reconcile_now();
    run_setup_if_configured(&registry, &runs, &ws.id);
    telemetry.event("session_created", "/session", Some(serde_json::json!({ "source": "pr" })));
    Ok(ws)
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
    runs: State<RunManager>,
    android: State<AndroidManager>,
) -> Result<(), String> {
    // Kill the dev server first, then give the teardown script its bounded
    // best-effort shot while the worktree still exists.
    runs.stop(&workspace_id);
    if let Some((ws, settings, root)) = registry.run_context(&workspace_id) {
        if let Some(script) = settings.teardown_script.filter(|s| !s.trim().is_empty()) {
            runs.run_teardown(&ws.id, &script, &ws.path, &root);
        }
        if settings.project_type == Some(ProjectType::FlutterRedroid) {
            android.remove(&ws.id);
        }
    }
    servers.stop(&workspace_id);
    watcher.unwatch(&workspace_id);
    registry.remove_workspace(&workspace_id, force)
}

// ── Run & preview (see docs/design/run-preview.md) ──

/// Start the project's run script in this workspace's worktree. For
/// flutter-redroid projects the redroid container is brought up first (off
/// this thread — progress streams via `workspace:android` + run-log events),
/// then the script runs with `ANDROID_SERIAL` pointed at it.
#[tauri::command]
pub fn run_start(
    workspace_id: String,
    registry: State<Registry>,
    runs: State<RunManager>,
    android: State<AndroidManager>,
) -> Result<(), String> {
    let (ws, settings, root) = registry.run_context(&workspace_id).ok_or("unknown workspace")?;
    let script = settings.run_script.filter(|s| !s.trim().is_empty()).ok_or("no run script configured")?;

    if settings.project_type == Some(ProjectType::FlutterRedroid) {
        let (android, runs) = (android.inner().clone(), runs.inner().clone());
        std::thread::spawn(move || {
            // ensure_ready logs + emits its own error state on failure.
            if let Ok(serial) = android.ensure_ready(&ws.id) {
                let env = [("ANDROID_SERIAL".to_string(), serial.clone()), ("BL_ANDROID_SERIAL".to_string(), serial)];
                let _ = runs.start(&ws.id, &script, &ws.path, &root, &env);
            }
        });
        return Ok(());
    }

    runs.start(&ws.id, &script, &ws.path, &root, &[])?;
    Ok(())
}

/// Stop this workspace's run (kills the whole process tree).
#[tauri::command]
pub fn run_stop(workspace_id: String, runs: State<RunManager>) {
    runs.stop(&workspace_id);
}

/// Current run state + recent output, for view remounts. Live updates arrive
/// via `workspace:run` / `workspace:run_log` events.
#[tauri::command]
pub fn run_state(workspace_id: String, runs: State<RunManager>) -> RunSnapshot {
    runs.snapshot(&workspace_id)
}

/// Current Android (redroid) state, for view remounts.
#[tauri::command]
pub fn android_state(workspace_id: String, android: State<AndroidManager>) -> Option<AndroidState> {
    android.state(&workspace_id)
}

/// Preview refcount from open run panels — the backend pushes
/// `workspace:android_frame` screencaps while any panel is watching
/// (the frontend never polls; see AGENTS.md boundaries).
#[tauri::command]
pub fn android_preview(workspace_id: String, enabled: bool, android: State<AndroidManager>) {
    android.set_preview(&workspace_id, enabled);
}

/// Inject a tap at normalized (0..1) preview coordinates.
#[tauri::command]
pub fn android_tap(workspace_id: String, x: f32, y: f32, android: State<AndroidManager>) -> Result<(), String> {
    android.tap(&workspace_id, x, y)
}

#[tauri::command]
pub fn list_workspaces(registry: State<Registry>) -> Vec<Workspace> {
    registry.all_workspaces()
}

#[tauri::command]
pub fn rename_workspace(workspace_id: String, name: String, registry: State<Registry>) {
    registry.rename_workspace(&workspace_id, &name);
}

/// Rename a fresh worktree's codename branch to the AI-proposed name (a plain
/// title also works — it gets sanitized). Returns the new branch name, or
/// null when skipped (quick chat, PR checkout, branch already pushed, or name
/// collision). Pokes the watcher so the UI picks the rename up immediately.
#[tauri::command]
pub fn rename_workspace_branch(
    workspace_id: String,
    branch: String,
    registry: State<Registry>,
    watcher: State<GitWatcher>,
) -> Result<Option<String>, String> {
    let renamed = registry.rename_branch_for_title(&workspace_id, &branch)?;
    if renamed.is_some() {
        watcher.refresh(&workspace_id);
    }
    Ok(renamed)
}

/// Clear a delivered init prompt (the chat view calls this after sending it).
#[tauri::command]
pub fn clear_init_prompt(workspace_id: String, registry: State<Registry>) {
    registry.clear_init_prompt(&workspace_id);
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
pub fn merge_workspace(
    workspace_id: String,
    registry: State<Registry>,
    supervisor: State<Supervisor>,
) -> Result<MergeResult, String> {
    let (_ws, root, branch, base) = resolve_workspace_branch(&registry, &workspace_id)?;
    let summary = git::merge_into_base(&root, &branch, &base)?;
    supervisor.poke(&workspace_id);
    Ok(MergeResult { branch, base, summary })
}

/// Push the workspace branch to `origin`.
#[tauri::command]
pub fn push_workspace(
    workspace_id: String,
    registry: State<Registry>,
    supervisor: State<Supervisor>,
) -> Result<PushResult, String> {
    let (_ws, root, branch, _base) = resolve_workspace_branch(&registry, &workspace_id)?;
    let output = git::push_branch(&root, "origin", &branch)?;
    supervisor.poke(&workspace_id);
    Ok(PushResult { branch, remote: "origin".to_string(), output })
}

/// Push the branch and open a GitHub PR via the API (routed through the repo's
/// bound account). Blocks fork PRs (read-only).
#[tauri::command]
pub async fn create_workspace_pr(
    workspace_id: String,
    title: String,
    body: String,
    registry: State<'_, Registry>,
    github: State<'_, crate::github::GithubManager>,
    supervisor: State<'_, Supervisor>,
    telemetry: State<'_, crate::telemetry::Telemetry>,
) -> Result<PrResult, String> {
    let (ws, root, branch, base) = resolve_workspace_branch(&registry, &workspace_id)?;
    if ws.pr_is_fork {
        return Err("this workspace tracks a fork PR — push access isn't available".into());
    }
    // Push the branch first (credential helper neutralized, matching the old path).
    git::push_branch(&root, "origin", &branch)?;
    let account_id = registry.project_account_id(&ws.project_id);
    let url = github.create_pr_for(&root, &branch, &base, &title, &body, account_id.as_deref()).await?;
    supervisor.poke(&workspace_id);
    telemetry.event("pr_created", "/session", None);
    Ok(PrResult { branch, base, url })
}

/// The GitHub account auto-detected for a project's origin remote (ignoring any
/// override) — used to label the per-project account selector.
#[tauri::command]
pub fn github_detect_account(
    project_id: String,
    registry: State<Registry>,
    github: State<crate::github::GithubManager>,
) -> Option<crate::github::model::AccountView> {
    let root = registry.project_root(&project_id)?;
    github.detect_account(&root)
}

/// Fetch the pull-request CI status for the workspace's branch (via the GitHub
/// API, routed through the account bound to the repo). `Ok(None)` means the
/// branch has no PR yet; `Err` means no account is bound or the API call failed.
#[tauri::command]
pub async fn workspace_pr_status(
    workspace_id: String,
    registry: State<'_, Registry>,
    github: State<'_, crate::github::GithubManager>,
) -> Result<Option<PrStatus>, String> {
    let (ws, root, branch, _base) = resolve_workspace_branch(&registry, &workspace_id)?;
    let account_id = registry.project_account_id(&ws.project_id);
    github.pr_status_for(&root, &branch, account_id.as_deref()).await
}

// ── Backend orchestration surface (see supervisor.rs / watcher.rs) ──

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

/// A complete, synchronous read of every workspace's sidebar state (diff stat,
/// session activity, PR/CI). The frontend seeds its store from this on mount,
/// then applies `workspace:*` event deltas — no startup ordering races, since
/// nothing depends on events emitted before the webview subscribed.
#[tauri::command]
pub fn get_sidebar_snapshot(
    registry: State<Registry>,
    watcher: State<GitWatcher>,
    supervisor: State<Supervisor>,
) -> Vec<SidebarWorkspace> {
    let statuses: std::collections::HashMap<String, crate::supervisor::WorkspaceStatus> =
        supervisor.sidebar_snapshot().into_iter().map(|s| (s.session.workspace_id.clone(), s)).collect();
    registry
        .all_workspaces()
        .into_iter()
        .filter_map(|w| {
            let status = statuses.get(&w.id)?;
            Some(SidebarWorkspace {
                workspace_id: w.id.clone(),
                diff_stat: watcher.diff_stat_snapshot(&w.id, &w.path),
                session: status.session.clone(),
                pr: status.pr.clone(),
            })
        })
        .collect()
}

/// One workspace's complete sidebar state (see [`get_sidebar_snapshot`]).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarWorkspace {
    pub workspace_id: String,
    pub diff_stat: crate::git::DiffStat,
    pub session: crate::supervisor::SessionPayload,
    pub pr: crate::supervisor::PrPayload,
}

/// Schedule an immediate PR re-poll for every workspace. Called on window
/// focus — the user is looking, so the safety-net cadence isn't fresh enough.
#[tauri::command]
pub fn refresh_pr_status(supervisor: State<Supervisor>) {
    supervisor.poke_all();
}

/// Force a git recompute + emit for one workspace (used by `refreshChanges`).
#[tauri::command]
pub fn request_git_refresh(workspace_id: String, watcher: State<GitWatcher>) {
    watcher.refresh(&workspace_id);
}

/// Runtime MCP + LSP status for a workspace. ACP doesn't expose these, so we
/// start a short-lived supplemental `opencode serve` (idle-reaped) and read
/// `/mcp` + `/lsp` over HTTP. Called by the ServerTools panel on open.
#[tauri::command]
pub async fn workspace_tools(
    workspace_id: String,
    registry: State<'_, Registry>,
    servers: State<'_, ServerManager>,
) -> Result<ToolsStatus, String> {
    let path = registry.workspace_path(&workspace_id).ok_or("unknown workspace")?;
    let servers = (*servers).clone();
    let id = workspace_id.clone();
    let base = tauri::async_runtime::spawn_blocking(move || servers.start(&id, &path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| {
            crate::logf!("tools", "workspace_tools ws={workspace_id} serve start FAILED: {e}");
            e
        })?
        .base_url;
    crate::logf!("tools", "workspace_tools ws={workspace_id} serve base={base}");

    // MCP servers connect asynchronously after `serve` announces its port, so a
    // fetch immediately after boot can come back empty. Retry once after a short
    // delay before giving up (this is why the panel showed "No MCP servers").
    let mut mcp = opencode_http::mcp_status(&base).await.unwrap_or_default();
    if mcp.is_empty() {
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        mcp = opencode_http::mcp_status(&base).await.unwrap_or_default();
    }
    let lsp = opencode_http::lsp_status(&base).await.unwrap_or_default();
    crate::logf!("tools", "workspace_tools ws={workspace_id} mcp={} lsp={}", mcp.len(), lsp.len());
    Ok(ToolsStatus { mcp, lsp })
}

/// Connect (enable) an MCP server at runtime on the workspace's supplemental serve.
#[tauri::command]
pub async fn mcp_connect(workspace_id: String, name: String, servers: State<'_, ServerManager>) -> Result<(), String> {
    let base = servers.status(&workspace_id).ok_or("server not running")?.base_url;
    opencode_http::mcp_connect(&base, &name).await
}

/// Disconnect (disable) an MCP server at runtime.
#[tauri::command]
pub async fn mcp_disconnect(
    workspace_id: String,
    name: String,
    servers: State<'_, ServerManager>,
) -> Result<(), String> {
    let base = servers.status(&workspace_id).ok_or("server not running")?.base_url;
    opencode_http::mcp_disconnect(&base, &name).await
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

/// The global default model (opencode's top-level `model` config), if set.
/// Applied by opencode to every new session across all workspaces.
#[tauri::command]
pub fn get_default_model() -> Option<String> {
    config::get_default_model(&config::global_dir())
}

/// Set (empty string clears) the global default model in the opencode config.
#[tauri::command]
pub fn set_default_model(model: String) -> Result<(), String> {
    config::set_default_model(&config::global_dir(), Some(model.as_str()).filter(|s| !s.is_empty()))
}

/// Open the webview inspector (we disable the default right-click menu, so this
/// is bound to a keyboard shortcut instead). Available because the tauri
/// `devtools` feature is enabled in Cargo.toml.
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// Absolute path of the backend debug logfile (for "Open logs" in the UI and
/// for the user to `tail -f` while reproducing an issue).
#[tauri::command]
pub fn log_path() -> Option<String> {
    crate::logx::path().map(|p| p.to_string_lossy().into_owned())
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
