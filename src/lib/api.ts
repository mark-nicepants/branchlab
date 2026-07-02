// Typed wrappers around Tauri IPC commands (the Rust backend).
// Keeping every `invoke` call behind this module means the rest of the app
// never types raw command-name strings, and backend changes are localized.

import { invoke } from "@tauri-apps/api/core";
import type {
  ConfigFile,
  DiffStat,
  EnvReport,
  FileChange,
  FileContent,
  MergeResult,
  PrResult,
  ProjectPrompts,
  ProjectUpdate,
  ProjectView,
  PushResult,
  RemoteInfo,
  ServerInfo,
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
 * directory (no git repo, no worktree) the agent can talk in. Returns a
 * Workspace with `kind: "QuickChat"`.
 *
 * NOTE: the matching Rust command (`create_quick_chat`) is not implemented yet
 * — see docs/redesign-open-ends.md. Fully mocked for the browser harness.
 */
export function createQuickChat(): Promise<Workspace> {
  return invoke<Workspace>("create_quick_chat");
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

/** List git remotes for a workspace's project root. */
export function listRemotes(workspaceId: string): Promise<RemoteInfo[]> {
  return invoke<RemoteInfo[]>("list_remotes", { workspaceId });
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
