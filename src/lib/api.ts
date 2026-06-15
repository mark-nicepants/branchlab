// Typed wrappers around Tauri IPC commands (the Rust backend).
// Keeping every `invoke` call behind this module means the rest of the app
// never types raw command-name strings, and backend changes are localized.

import { invoke } from "@tauri-apps/api/core";
import type {
  DiffStat,
  EnvReport,
  ProjectView,
  ServerInfo,
  Workspace,
} from "./types";

/** Probe PATH for the external tools OpenScope depends on (opencode, git). */
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
 * to fork from the repo's current branch. Returns the new workspace.
 */
export function createWorkspace(projectId: string, base?: string): Promise<Workspace> {
  return invoke<Workspace>("create_workspace", { projectId, base: base ?? null });
}

/** Remove a worktree workspace (stops its server first). */
export function removeWorkspace(workspaceId: string, force: boolean): Promise<void> {
  return invoke<void>("remove_workspace", { workspaceId, force });
}

export function listWorkspaces(): Promise<Workspace[]> {
  return invoke<Workspace[]>("list_workspaces");
}

/** Set a workspace's display name (AI-generated once, or manual rename). */
export function renameWorkspace(workspaceId: string, name: string): Promise<void> {
  return invoke<void>("rename_workspace", { workspaceId, name });
}

export function workspaceDiffStat(workspaceId: string): Promise<DiffStat> {
  return invoke<DiffStat>("workspace_diff_stat", { workspaceId });
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
