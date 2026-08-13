//! Tauri command surface — the IPC boundary the frontend calls.

use std::path::PathBuf;

use tauri::{Emitter, State};

use crate::config::{self, ConfigFile};
use crate::engine::opencode_http::{self, ToolsStatus};
use crate::git::{self, FileContent};
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
/// optional — omit to fork from the repo's current branch. Returns instantly:
/// the expensive checkout + setup script run in the background (SetupManager),
/// with progress in the chat's setup card. Async so the cheap git probes
/// (base branch, codenames) stay off the main thread too.
#[tauri::command]
pub async fn create_workspace(
    project_id: String,
    base: Option<String>,
    init_prompt: Option<String>,
    registry: State<'_, Registry>,
    setup: State<'_, crate::setup::SetupManager>,
    supervisor: State<'_, Supervisor>,
    telemetry: State<'_, crate::telemetry::Telemetry>,
) -> Result<Workspace, String> {
    let ws = registry.create_workspace(&project_id, base, init_prompt)?;
    setup.start(&ws.id); // watches git + boots the engine once the worktree exists
    supervisor.reconcile_now();
    telemetry.event("session_created", "/session", Some(serde_json::json!({ "source": "branch" })));
    Ok(ws)
}

/// Create a context-free quick chat: an app-managed scratch directory with its
/// own opencode server, but no git repo or project. Not registered with the
/// git watcher — there is nothing to diff.
#[tauri::command]
pub async fn create_quick_chat(
    init_prompt: Option<String>,
    registry: State<'_, Registry>,
    supervisor: State<'_, Supervisor>,
    telemetry: State<'_, crate::telemetry::Telemetry>,
) -> Result<Workspace, String> {
    let ws = registry.create_quick_chat(init_prompt)?;
    supervisor.reconcile_now();
    telemetry.event("session_created", "/session", Some(serde_json::json!({ "source": "quick_chat" })));
    Ok(ws)
}

/// Propose setup/teardown scripts for a project with AI: BranchLab collects
/// the repo context (manifests, README, file list) and asks the model over a
/// throwaway session on the base workspace's engine. The result fills the
/// Scripts form for user review — nothing is saved here.
#[tauri::command]
pub async fn generate_setup_scripts(
    project_id: String,
    registry: State<'_, Registry>,
    chat: State<'_, crate::chat::manager::ChatManager>,
) -> Result<crate::engine::GeneratedSetup, String> {
    let base = registry.base_workspace(&project_id).ok_or("unknown project")?;
    let root = base.path.clone();
    let context = tauri::async_runtime::spawn_blocking(move || crate::setup::collect_repo_context(&root))
        .await
        .map_err(|e| e.to_string())?;
    chat.generate_setup(&base.id, std::path::Path::new(&base.path), context)
        .await
        .ok_or_else(|| "the model did not return a usable proposal".to_string())
}

/// Re-run a failed workspace setup (the chat card's Retry button). The
/// worktree checkout is idempotent; an already-valid worktree is kept as-is
/// and only the setup script re-runs.
#[tauri::command]
pub fn retry_setup(workspace_id: String, setup: State<crate::setup::SetupManager>) {
    setup.start(&workspace_id);
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
    let root = registry.repo_root(&project_id).ok_or("unknown project")?;
    let override_id = registry.project_account_id(&project_id);
    let (account, owner, repo) = github.resolve_account(&root, override_id.as_deref())?;
    let client = github.client_for(&account.id)?;
    client.list_open_prs(&owner, &repo).await
}

/// Check a PR out into a fresh worktree and register it as a workspace.
#[tauri::command]
pub async fn create_workspace_from_pr(
    project_id: String,
    pr_number: i64,
    registry: State<'_, Registry>,
    github: State<'_, crate::github::GithubManager>,
    setup: State<'_, crate::setup::SetupManager>,
    supervisor: State<'_, Supervisor>,
    telemetry: State<'_, crate::telemetry::Telemetry>,
) -> Result<Workspace, String> {
    let root = registry.repo_root(&project_id).ok_or("unknown project")?;
    let override_id = registry.project_account_id(&project_id);
    let (account, owner, repo) = github.resolve_account(&root, override_id.as_deref())?;
    let client = github.client_for(&account.id)?;
    let detail = client.pr_detail(&owner, &repo, pr_number).await?;

    let title = if detail.title.is_empty() { format!("PR #{pr_number}") } else { detail.title.clone() };
    let meta = crate::project::PrWorkspaceMeta {
        number: pr_number,
        title,
        base_ref: detail.base_ref,
        is_fork: detail.is_fork,
    };
    let ws = registry.create_workspace_from_pr(&project_id, meta)?;
    setup.start(&ws.id); // fetch + checkout happen in the background pipeline
    supervisor.reconcile_now();
    telemetry.event("session_created", "/session", Some(serde_json::json!({ "source": "pr" })));
    Ok(ws)
}

/// Remove a workspace: run the project's teardown script (best-effort,
/// bounded — the worktree must still exist for it), stop its server, then
/// remove the worktree. Async so the teardown wait never blocks the UI; the
/// sidebar shows a spinner while the returned promise is in flight.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remove_workspace(
    workspace_id: String,
    force: bool,
    app: tauri::AppHandle,
    registry: State<'_, Registry>,
    setup: State<'_, crate::setup::SetupManager>,
    servers: State<'_, ServerManager>,
    watcher: State<'_, GitWatcher>,
    tasks: State<'_, crate::tasks::TaskStore>,
) -> Result<(), String> {
    let setup = setup.inner().clone();
    let ws_id = workspace_id.clone();
    // Blocking script wait (≤30s) off the async pool's core threads.
    let _ = tauri::async_runtime::spawn_blocking(move || setup.run_teardown(&ws_id)).await;
    servers.stop(&workspace_id);
    watcher.unwatch(&workspace_id);
    registry.remove_workspace(&workspace_id, force)?;
    // Auto-track: a "My work" card linked to this session moves to its done
    // column and drops the (now dangling) link.
    if tasks.on_workspace_removed(&workspace_id) {
        let _ = app.emit("tasks:changed", tasks.snapshot());
    }
    Ok(())
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
    let root = registry.repo_root(&project_id)?;
    github.detect_account(&root)
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

/// A complete read of every workspace's sidebar state (diff stat, session
/// activity, PR/CI). The frontend seeds its store from this on mount, then
/// applies `workspace:*` event deltas — no startup ordering races, since
/// nothing depends on events emitted before the webview subscribed.
/// Async because uncached diff stats spawn `git` per workspace — on the main
/// thread that would block the UI event loop right at first paint.
#[tauri::command]
pub async fn get_sidebar_snapshot(
    registry: State<'_, Registry>,
    watcher: State<'_, GitWatcher>,
    supervisor: State<'_, Supervisor>,
) -> Result<Vec<SidebarWorkspace>, String> {
    let statuses: std::collections::HashMap<String, crate::supervisor::WorkspaceStatus> =
        supervisor.sidebar_snapshot().into_iter().map(|s| (s.session.workspace_id.clone(), s)).collect();
    let rows = registry
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
        .collect();
    Ok(rows)
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
pub fn start_server(
    workspace_id: String,
    registry: State<Registry>,
    servers: State<ServerManager>,
) -> Result<ServerInfo, String> {
    with_workspace_path(&registry, &workspace_id, |path| servers.start(&workspace_id, path))
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

/// Frontend startup marks land on the backend's boot-relative perf timeline
/// (grep `[perf]` in the debug log).
#[tauri::command]
pub fn perf_mark(name: String) {
    crate::logf!("perf", "{name} +{}ms", crate::logx::boot_ms());
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
