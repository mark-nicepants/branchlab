// Typed wrappers around Tauri IPC commands (the Rust backend).
// Keeping every `invoke` call behind this module means the rest of the app
// never types raw command-name strings, and backend changes are localized.

import { invoke } from "@tauri-apps/api/core";
import type {
  Account,
  ActivityEntry,
  BoardSnapshot,
  Task,
  UnlinkedTask,
  IssueSummary,
  AutofixMode,
  PrSummary,
  ReviewInboxItem,
  ChatAttachment,
  ChatSnapshot,
  ConfigFile,
  EnvReport,
  EstimateUnit,
  FileContent,
  GeneratedSetup,
  GeneratedTitle,
  PrResult,
  ProjectUpdate,
  ProjectView,
  ServerInfo,
  SidebarWorkspace,
  SuggestedPlan,
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

/**
 * Rename a fresh worktree's codename branch to the AI-proposed name (a plain
 * title also works — the backend sanitizes either). Resolves to the new
 * branch name, or null when skipped (quick chat, PR checkout, branch already
 * pushed to origin, or name collision).
 */
export function renameWorkspaceBranch(
  workspaceId: string,
  branch: string,
): Promise<string | null> {
  return invoke<string | null>("rename_workspace_branch", {
    workspaceId,
    branch,
  });
}

/** Clear a delivered init prompt so it is never sent twice. */
export function clearInitPrompt(workspaceId: string): Promise<void> {
  return invoke<void>("clear_init_prompt", { workspaceId });
}

/** Update project metadata and prompts. */
export function updateProject(
  projectId: string,
  update: ProjectUpdate,
): Promise<ProjectView> {
  return invoke<ProjectView>("update_project", { projectId, update });
}

/** Ask the AI to propose setup/teardown scripts for a project. The backend
 *  collects the repo context (manifests, README) and prompts a throwaway
 *  session; the result fills the Scripts form for review — nothing is saved.
 *  Can take ~10-60s (one model round-trip). */
export function generateSetupScripts(
  projectId: string,
): Promise<GeneratedSetup> {
  return invoke<GeneratedSetup>("generate_setup_scripts", { projectId });
}

/** Re-run a failed workspace setup (progress arrives via chat + `workspace:setup`). */
export function retrySetup(workspaceId: string): Promise<void> {
  return invoke<void>("retry_setup", { workspaceId });
}

/** Remove a worktree workspace (stops its server first; runs the project's
 *  teardown script, so this can take up to ~30s). Resolves to the task that
 *  was linked to it, if any — the UI offers to mark it done. */
export function removeWorkspace(
  workspaceId: string,
  force: boolean,
): Promise<UnlinkedTask | null> {
  return invoke<UnlinkedTask | null>("remove_workspace", {
    workspaceId,
    force,
  });
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

/** Push the branch and create a GitHub PR (requires `gh`). */
export function createWorkspacePr(
  workspaceId: string,
  title: string,
  body: string,
): Promise<PrResult> {
  return invoke<PrResult>("create_workspace_pr", { workspaceId, title, body });
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

/** Generate an AI title + conventional branch name from the first message
 *  (one prompt on a throwaway ACP session). */
export function chatGenerateTitle(
  workspaceId: string,
  text: string,
): Promise<GeneratedTitle | null> {
  return invoke<GeneratedTitle | null>("chat_generate_title", {
    workspaceId,
    text,
  });
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

// Stamp a frontend startup milestone on the backend's perf timeline.
export function perfMark(name: string): Promise<void> {
  return invoke("perf_mark", { name });
}

// ── Telemetry (anonymous usage analytics; see src-tauri/src/telemetry.rs) ──

/** Report a screen change, website-style (e.g. "/session", "/settings/general"). */
export function telemetryPageview(url: string): Promise<void> {
  return invoke<void>("telemetry_pageview", { url });
}

export function telemetryGetEnabled(): Promise<boolean> {
  return invoke<boolean>("telemetry_get_enabled");
}

export function telemetrySetEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("telemetry_set_enabled", { enabled });
}

// ── "My work" task board (src-tauri/src/tasks.rs) ──

/** The full live board (seed on mount; `tasks:changed` pushes updates). */
export function boardSnapshot(): Promise<BoardSnapshot> {
  return invoke<BoardSnapshot>("board_snapshot");
}

/** Set the board-global estimate unit; emits `tasks:changed` itself. */
export function boardSetEstimateUnit(unit: EstimateUnit): Promise<void> {
  return invoke<void>("board_set_estimate_unit", { unit });
}

export function taskCreate(
  title: string,
  opts?: {
    description?: string;
    projectId?: string;
    columnId?: string;
    /** Create as a subtask — inherits the parent's project (nesting refused). */
    parentId?: string;
  },
): Promise<Task> {
  return invoke<Task>("task_create", {
    title,
    description: opts?.description ?? null,
    projectId: opts?.projectId ?? null,
    columnId: opts?.columnId ?? null,
    parentId: opts?.parentId ?? null,
  });
}

/** Empty strings clear description/projectId; a negative `estimate` clears
 *  it; `dependsOn` replaces the whole blocked-by list (the backend drops
 *  self/unknown ids); omitted fields are unchanged. */
export function taskUpdate(
  taskId: string,
  patch: {
    title?: string;
    description?: string;
    projectId?: string;
    estimate?: number;
    dependsOn?: string[];
  },
): Promise<void> {
  return invoke<void>("task_update", { taskId, patch });
}

/** AI-plan a parent's subtasks (blocked-by ordering + estimates in the
 *  configured unit) on the
 *  project's engine. Applies the plan and emits `tasks:changed` itself; can
 *  take a model round-trip (~10-60s). */
export function taskSuggestPlan(parentId: string): Promise<SuggestedPlan> {
  return invoke<SuggestedPlan>("task_suggest_plan", { parentId });
}

export function taskDelete(taskId: string): Promise<void> {
  return invoke<void>("task_delete", { taskId });
}

/** `position` is the caller-computed fractional index within the column. */
export function taskMove(
  taskId: string,
  columnId: string,
  position: number,
): Promise<void> {
  return invoke<void>("task_move", { taskId, columnId, position });
}

/** Link a card to its session; the backend moves it to the active column. */
export function taskLinkWorkspace(
  taskId: string,
  workspaceId: string,
): Promise<void> {
  return invoke<void>("task_link_workspace", { taskId, workspaceId });
}

/** Read-only transcript for a possibly-deleted workspace (the chat survives
 *  workspace deletion) — powers the task card's archived-chat view. */
export function chatArchive(workspaceId: string): Promise<ChatSnapshot> {
  return invoke<ChatSnapshot>("chat_archive", { workspaceId });
}

/** Start a session for a board task (backend builds the prompt, links the
 *  card, and holds delivery until the workspace finishes provisioning). */
export function taskStart(taskId: string): Promise<Workspace> {
  return invoke<Workspace>("task_start", { taskId });
}

/** Move a task to the done-role column (the "mark as done" toast action). */
export function taskMarkDone(taskId: string): Promise<void> {
  return invoke<void>("task_mark_done", { taskId });
}

/** A task's activity feed (events + comments), oldest first. */
export function taskActivity(taskId: string): Promise<ActivityEntry[]> {
  return invoke<ActivityEntry[]>("task_activity", { taskId });
}

/** Comment on a task. Plain text lands in the feed; a leading slash runs a
 *  session command first (/start, /send, /stop, /done) and records it.
 *  Errors are user-facing strings; the backend emits `tasks:changed` itself. */
export function taskComment(
  taskId: string,
  body: string,
): Promise<ActivityEntry> {
  return invoke<ActivityEntry>("task_comment", { taskId, body });
}

/** Open GitHub issues for a project's repo (task-board import picker). */
export function listProjectIssues(
  projectId: string,
): Promise<IssueSummary[]> {
  return invoke<IssueSummary[]>("list_project_issues", { projectId });
}

