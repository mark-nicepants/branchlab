// Typed wrappers around Tauri IPC commands (the Rust backend).
// Keeping every `invoke` call behind this module means the rest of the app
// never types raw command-name strings, and backend changes are localized.

import { invoke } from "@tauri-apps/api/core";
import type {
  Account,
  AutofixMode,
  PrSummary,
  ReviewInboxItem,
  ChatAttachment,
  ChatSnapshot,
  ConfigFile,
  DiffStat,
  EnvReport,
  FileChange,
  FileContent,
  MergeResult,
  PrResult,
  PrStatus,
  ProjectPrompts,
  ProjectUpdate,
  ProjectView,
  PushResult,
  RemoteInfo,
  ServerInfo,
  SidebarWorkspace,
  ToolsStatus,
  Workspace,
} from "./types";

/** Probe PATH for the external tools BranchLab depends on (opencode, git). */
export function probeEnvironment(): Promise<EnvReport> {
  return invoke<EnvReport>("probe_environment");
}

/** Register a git repo as a project (creates its base workspace). */
export function addProject(path: string): Promise<ProjectView> {
  return invoke<ProjectView>("add_project", { path });
}

export function listProjects(): Promise<ProjectView[]> {
  return invoke<ProjectView[]>("list_projects");
}

export function removeProject(projectId: string): Promise<void> {
  return invoke<void>("remove_project", { projectId });
}

/** Start (or reuse) the opencode server for a workspace; returns its base URL. */
export function startServer(workspaceId: string): Promise<ServerInfo> {
  return invoke<ServerInfo>("start_server", { workspaceId });
}

export function stopServer(workspaceId: string): Promise<void> {
  return invoke<void>("stop_server", { workspaceId });
}

export function serverStatus(workspaceId: string): Promise<ServerInfo | null> {
  return invoke<ServerInfo | null>("server_status", { workspaceId });
}

// ── M2: worktrees & fleet ──

export function listBranches(projectId: string): Promise<string[]> {
  return invoke<string[]>("list_branches", { projectId });
}

/**
 * Create a workspace (a worktree on a generated branch codename). Omit `base`
 * to fork from the repo's current branch. `initPrompt` is sent to the AI once
 * the workspace server is ready.
 */
export function createWorkspace(
  projectId: string,
  base?: string,
  initPrompt?: string,
): Promise<Workspace> {
  return invoke<Workspace>("create_workspace", {
    projectId,
    base: base ?? null,
    initPrompt: initPrompt ?? null,
  });
}

/**
 * Create a context-free "quick chat" workspace: an app-managed empty scratch
 * directory (no git repo, no worktree) the agent can talk in. Persisted in
 * the registry, so it survives restarts until deleted. Returns a Workspace
 * with `kind: "QuickChat"`. `initPrompt` is sent once the server is ready.
 */
export function createQuickChat(initPrompt?: string): Promise<Workspace> {
  return invoke<Workspace>("create_quick_chat", {
    initPrompt: initPrompt ?? null,
  });
}

/** Update project metadata, prompts, and default model. */
export function updateProject(
  projectId: string,
  update: ProjectUpdate,
): Promise<ProjectView> {
  return invoke<ProjectView>("update_project", { projectId, update });
}

/** Get a project's configured prompts. */
export function getProjectPrompts(projectId: string): Promise<ProjectPrompts> {
  return invoke<ProjectPrompts>("get_project_prompts", { projectId });
}

/** Remove a worktree workspace (stops its server first). */
export function removeWorkspace(
  workspaceId: string,
  force: boolean,
): Promise<void> {
  return invoke<void>("remove_workspace", { workspaceId, force });
}

export function listWorkspaces(): Promise<Workspace[]> {
  return invoke<Workspace[]>("list_workspaces");
}

/** Set a workspace's display name (AI-generated once, or manual rename). */
export function renameWorkspace(
  workspaceId: string,
  name: string,
): Promise<void> {
  return invoke<void>("rename_workspace", { workspaceId, name });
}

export function workspaceDiffStat(workspaceId: string): Promise<DiffStat> {
  return invoke<DiffStat>("workspace_diff_stat", { workspaceId });
}

/** Changed files for the diff panel. `against` defaults to HEAD (local). */
export function workspaceChanges(
  workspaceId: string,
  against?: string,
): Promise<FileChange[]> {
  return invoke<FileChange[]>("workspace_changes", {
    workspaceId,
    against: against ?? null,
  });
}

/** Unified diff text for one file. */
export function workspaceFileDiff(
  workspaceId: string,
  file: string,
  against?: string,
): Promise<string> {
  return invoke<string>("workspace_file_diff", {
    workspaceId,
    file,
    against: against ?? null,
  });
}

/** Discard a file's local changes (restore to HEAD, or delete if untracked). */
export function discardFile(workspaceId: string, file: string): Promise<void> {
  return invoke<void>("discard_file", { workspaceId, file });
}

/** All files in a workspace (tracked + untracked) for the file-tree browser. */
export function workspaceFiles(workspaceId: string): Promise<string[]> {
  return invoke<string[]>("workspace_files", { workspaceId });
}

/** Read a workspace file's contents for the in-app viewer. */
export function readFile(
  workspaceId: string,
  file: string,
): Promise<FileContent> {
  return invoke<FileContent>("read_file", { workspaceId, file });
}

/** Commit all changes in a workspace. */
export function commitWorkspace(
  workspaceId: string,
  message: string,
): Promise<string> {
  return invoke<string>("commit_workspace", { workspaceId, message });
}

/** Merge the workspace branch into its base branch. */
export function mergeWorkspace(workspaceId: string): Promise<MergeResult> {
  return invoke<MergeResult>("merge_workspace", { workspaceId });
}

/** Push the workspace branch to origin. */
export function pushWorkspace(workspaceId: string): Promise<PushResult> {
  return invoke<PushResult>("push_workspace", { workspaceId });
}

/** Push the branch and create a GitHub PR (requires `gh`). */
export function createWorkspacePr(
  workspaceId: string,
  title: string,
  body: string,
): Promise<PrResult> {
  return invoke<PrResult>("create_workspace_pr", { workspaceId, title, body });
}

/**
 * Fetch the PR CI status for a workspace's branch (via `gh`). Resolves to
 * `null` when the branch has no PR yet; rejects when `gh` is unavailable or the
 * repo has no GitHub remote.
 */
export function workspacePrStatus(
  workspaceId: string,
): Promise<PrStatus | null> {
  return invoke<PrStatus | null>("workspace_pr_status", { workspaceId });
}

// ── GitHub accounts (Rust `github` module; events via src/lib/events.ts) ──

/** List the connected GitHub accounts (public identity only, never tokens). */
export function listAccounts(): Promise<Account[]> {
  return invoke<Account[]>("github_list_accounts");
}

/** Start an interactive `gh auth login --web` device flow. Returns a loginId;
 *  progress arrives via the `github:login` event. `host` defaults to github.com. */
export function beginAccountLogin(host?: string): Promise<string> {
  return invoke<string>("github_start_device_login", { host: host ?? null });
}

/** Cancel an in-flight device login (kills the `gh` child). */
export function cancelAccountLogin(loginId: string): Promise<void> {
  return invoke<void>("github_cancel_login", { loginId });
}

/** Deterministic fallback: add an account from a pasted Personal Access Token. */
export function addAccountWithToken(
  token: string,
  host?: string,
): Promise<Account> {
  return invoke<Account>("github_add_account_with_token", {
    host: host ?? null,
    token,
  });
}

/** Sign an account out and forget it. Emits `github:accounts`. */
export function removeAccount(accountId: string): Promise<void> {
  return invoke<void>("github_remove_account", { accountId });
}

/** Re-emit `github:accounts` (+ review inbox) so the UI can seed on mount —
 *  events aren't buffered. */
export function resyncGitHub(): Promise<void> {
  return invoke<void>("resync_github");
}

/** The cached review inbox (PRs awaiting your review across all accounts). */
export function reviewInbox(): Promise<ReviewInboxItem[]> {
  return invoke<ReviewInboxItem[]>("github_review_inbox");
}

/** Check a PR out into a fresh worktree and register it as a workspace. */
export function createWorkspaceFromPr(
  projectId: string,
  prNumber: number,
): Promise<Workspace> {
  return invoke<Workspace>("create_workspace_from_pr", {
    projectId,
    prNumber,
  });
}

/** Open PRs for a project (yours + review-requested + assigned), for the picker. */
export function listProjectPrs(projectId: string): Promise<PrSummary[]> {
  return invoke<PrSummary[]>("list_project_prs", { projectId });
}

/** The account auto-detected for a project's origin remote (null if none maps). */
export function githubDetectAccount(
  projectId: string,
): Promise<Account | null> {
  return invoke<Account | null>("github_detect_account", { projectId });
}

/** Force a fresh review-inbox poll now (result arrives via `github:review_inbox`). */
export function refreshReviewInbox(): Promise<void> {
  return invoke<void>("github_refresh_review_inbox");
}

// ── Chat layer (Rust `chat` module; deltas pushed via src/lib/events.ts) ──

/** Ensure the conversation + ACP engine exist and return the initial snapshot
 *  (newest page of entries + advertised config options). Call on mount. */
export function chatOpen(workspaceId: string): Promise<ChatSnapshot> {
  return invoke<ChatSnapshot>("chat_open", { workspaceId });
}

/** Fetch a page of older history before `beforeSeq`. */
export function chatHistory(
  workspaceId: string,
  beforeSeq: number,
): Promise<ChatSnapshot> {
  return invoke<ChatSnapshot>("chat_history", { workspaceId, beforeSeq });
}

/** Send a user message. `display` is shown; `sent` goes to the AI. */
export function chatSend(args: {
  workspaceId: string;
  display: string;
  sent: string;
  attachments?: ChatAttachment[];
  origin?: string;
  model?: string;
  variant?: string;
  agent?: string;
}): Promise<void> {
  return invoke<void>("chat_send", {
    workspaceId: args.workspaceId,
    display: args.display,
    sent: args.sent,
    attachments: args.attachments ?? null,
    origin: args.origin ?? null,
    model: args.model ?? null,
    variant: args.variant ?? null,
    agent: args.agent ?? null,
  });
}

/** Generate an AI title from the first message (throwaway ACP session). */
export function chatGenerateTitle(
  workspaceId: string,
  text: string,
): Promise<string | null> {
  return invoke<string | null>("chat_generate_title", { workspaceId, text });
}

/** Abort the in-flight turn for a workspace. */
export function chatAbort(workspaceId: string): Promise<void> {
  return invoke<void>("chat_abort", { workspaceId });
}

/** Change a session config option (model / mode) by id + value. Reasoning is
 *  NOT set here — opencode doesn't expose it over ACP; it's configured per-model
 *  in the opencode config (see Settings → Models). */
export function chatSetConfig(
  workspaceId: string,
  id: string,
  value: string,
): Promise<void> {
  return invoke<void>("chat_set_config", { workspaceId, id, value });
}

/** Answer a pending permission request; `optionId` null cancels/rejects. */
export function chatAnswerPermission(
  workspaceId: string,
  requestId: string,
  optionId: string | null,
): Promise<void> {
  return invoke<void>("chat_answer_permission", {
    workspaceId,
    requestId,
    optionId,
  });
}

/** Start a fresh engine session (compact / clear), keeping all prior entries. */
export function chatNewSession(
  workspaceId: string,
  reason: "compacted" | "cleared",
): Promise<void> {
  return invoke<void>("chat_new_session", { workspaceId, reason });
}

// ── Backend orchestration (events pushed back via src/lib/events.ts) ──

/** Tell the backend which workspace is on screen (gets changes + todos). */
export function setActiveWorkspace(workspaceId: string | null): Promise<void> {
  return invoke<void>("set_active_workspace", { workspaceId });
}

/** Set a workspace's PR autofix mode (persisted; reconciles the supervisor). */
export function setAutofixMode(
  workspaceId: string,
  mode: AutofixMode,
): Promise<void> {
  return invoke<void>("set_autofix_mode", { workspaceId, mode });
}

/** A complete snapshot of every workspace's sidebar state (diff stat, session,
 *  PR/CI). Seeds the store on mount; `workspace:*` events apply deltas after. */
export function getSidebarSnapshot(): Promise<SidebarWorkspace[]> {
  return invoke<SidebarWorkspace[]>("get_sidebar_snapshot");
}

/** Schedule an immediate PR re-poll for every workspace (window focus). */
export function refreshPrStatus(): Promise<void> {
  return invoke<void>("refresh_pr_status");
}

/** Force a git recompute + push for one workspace (used by refreshChanges). */
export function requestGitRefresh(workspaceId: string): Promise<void> {
  return invoke<void>("request_git_refresh", { workspaceId });
}

/** List git remotes for a workspace's project root. */
export function listRemotes(workspaceId: string): Promise<RemoteInfo[]> {
  return invoke<RemoteInfo[]>("list_remotes", { workspaceId });
}

/** Runtime MCP + LSP status (starts a supplemental `opencode serve` on demand). */
export function workspaceTools(workspaceId: string): Promise<ToolsStatus> {
  return invoke<ToolsStatus>("workspace_tools", { workspaceId });
}

/** Connect (enable) an MCP server at runtime. */
export function mcpConnect(workspaceId: string, name: string): Promise<void> {
  return invoke<void>("mcp_connect", { workspaceId, name });
}

/** Disconnect (disable) an MCP server at runtime. */
export function mcpDisconnect(
  workspaceId: string,
  name: string,
): Promise<void> {
  return invoke<void>("mcp_disconnect", { workspaceId, name });
}

// ── M3: config & internals ──

/** Read the global or project opencode config file. */
export function readConfig(
  scope: "global" | "project",
  workspaceId?: string,
): Promise<ConfigFile> {
  return invoke<ConfigFile>("read_config", {
    scope,
    workspaceId: workspaceId ?? null,
  });
}

/** Write a config file; returns the written path. */
export function writeConfig(
  scope: "global" | "project",
  content: string,
  workspaceId?: string,
): Promise<string> {
  return invoke<string>("write_config", {
    scope,
    workspaceId: workspaceId ?? null,
    content,
  });
}

/** The global default model (opencode's top-level `model`), or null if unset.
 *  opencode applies it to every new session across all workspaces. */
export function getDefaultModel(): Promise<string | null> {
  return invoke<string | null>("get_default_model");
}

/** Set (empty string clears) the global default model. */
export function setDefaultModel(model: string): Promise<void> {
  return invoke<void>("set_default_model", { model });
}

/** Restart a workspace's server (to apply config changes). */
export function restartServer(workspaceId: string): Promise<ServerInfo> {
  return invoke<ServerInfo>("restart_server", { workspaceId });
}

/** Info for every running opencode server (drives the fleet dashboard). */
export function listServers(): Promise<ServerInfo[]> {
  return invoke<ServerInfo[]>("list_servers");
}

/** Heartbeat to defer idle reaping of the active workspace's server. */
export function touchServer(workspaceId: string): Promise<void> {
  return invoke<void>("touch_server", { workspaceId });
}

/** Open the webview inspector (bound to a shortcut; right-click menu is disabled). */
export function openDevtools(): Promise<void> {
  return invoke<void>("open_devtools");
}

/**
 * Open a path externally. Pass a macOS app name (`open -a`, e.g. "Terminal",
 * "Visual Studio Code"); omit `app` to reveal it in Finder.
 */
export function openExternal(path: string, app?: string): Promise<void> {
  return invoke<void>("open_external", { path, app: app ?? null });
}

/** Absolute path of the backend debug logfile (null if logging failed to init). */
export function logPath(): Promise<string | null> {
  return invoke<string | null>("log_path");
}

// ── Telemetry (anonymous usage analytics; see src-tauri/src/telemetry.rs) ──

/** Report a screen change, website-style (e.g. "/session", "/settings/general"). */
export function telemetryPageview(url: string): Promise<void> {
  return invoke<void>("telemetry_pageview", { url });
}

/** Track a named event. `data` must stay coarse — enum-like values only. */
export function telemetryEvent(
  name: string,
  url: string,
  data?: Record<string, unknown>,
): Promise<void> {
  return invoke<void>("telemetry_event", { name, url, data: data ?? null });
}

export function telemetryGetEnabled(): Promise<boolean> {
  return invoke<boolean>("telemetry_get_enabled");
}

export function telemetrySetEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("telemetry_set_enabled", { enabled });
}
