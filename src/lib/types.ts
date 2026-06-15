// ── Backend (Rust IPC) types — mirror src-tauri/src/{env,project,server}.rs ──

export interface ToolStatus {
  found: boolean;
  path: string | null;
  version: string | null;
}

export interface EnvReport {
  opencode: ToolStatus;
  git: ToolStatus;
}

export type WorkspaceKind = "Base" | "Worktree";

export interface Workspace {
  id: string;
  project_id: string;
  kind: WorkspaceKind;
  path: string;
  branch: string | null;
  /** AI-generated display name (from first chat), else null → fall back to branch. */
  name: string | null;
  /** Branch this workspace was forked from (for the "Branched X from Y" line). */
  base_branch: string | null;
}

/** Human label for a workspace: explicit name, else branch, else a fallback. */
export function workspaceLabel(w: Workspace): string {
  return w.name ?? w.branch ?? "workspace";
}

export interface Project {
  id: string;
  name: string;
  root_path: string;
  default_branch: string | null;
}

// `ProjectView` flattens Project fields + a workspaces array.
export interface ProjectView extends Project {
  workspaces: Workspace[];
}

export interface ServerInfo {
  workspace_id: string;
  base_url: string;
  port: number;
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export interface FileChange {
  path: string;
  /** "modified" | "added" | "deleted" | "renamed" | "untracked" */
  status: string;
  insertions: number;
  deletions: number;
}

export interface FileContent {
  path: string;
  /** UTF-8 text. Empty when `binary` is true. */
  content: string;
  /** File looks binary — `content` is empty. */
  binary: boolean;
  /** File exceeded the size cap; `content` holds only the first chunk. */
  truncated: boolean;
  /** File size on disk, in bytes. */
  size: number;
}

export interface ConfigFile {
  path: string;
  content: string;
  exists: boolean;
}

// ── OpenCode HTTP API types (subset we use; from the OpenAPI 3.1 spec) ──

export interface Session {
  id: string;
  title: string;
  directory: string;
  projectID: string;
}

export type MessageRole = "user" | "assistant";

export interface MessageInfo {
  id: string;
  role: MessageRole;
  sessionID: string;
}

/** A part of a message. We render `text`; other kinds get a one-line summary. */
export interface Part {
  id: string;
  messageID: string;
  sessionID: string;
  type:
    | "text"
    | "reasoning"
    | "tool"
    | "file"
    | "step-start"
    | "step-finish"
    | string;
  text?: string;
  // tool parts carry a tool name + state; kept loose for the MVP summary.
  tool?: string;
  state?: { status?: string };
}

export interface MessageWithParts {
  info: MessageInfo;
  parts: Part[];
}

/** SSE event envelope: { id, type, properties }. */
export interface BusEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

/** A selectable model, flattened from /config/providers. */
export interface ModelOption {
  providerID: string;
  modelID: string;
  label: string;
  /** Max context window in tokens (model.limit.context), if known. */
  contextLimit?: number;
}

/** Context-window usage for the active session. */
export interface ContextInfo {
  used: number;
  max: number;
}
