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
  /** Tool name for tool parts (e.g. "edit", "bash", "read"). */
  tool?: string;
  /** Runtime state of a tool call. */
  state?: ToolState;
  /** Filename for file parts. */
  filename?: string;
  /** URL/path for file parts. */
  url?: string;
  /** Description for subtask parts. */
  description?: string;
  /** Agent name for subtask parts. */
  agent?: string;
}

/** Runtime state of a tool call part. */
export interface ToolState {
  status?: "pending" | "running" | "completed" | "error" | string;
  /** Tool arguments. */
  input?: Record<string, unknown>;
  /** Tool result text (when completed). */
  output?: string;
  /** Human-readable title while running or after completion. */
  title?: string;
  /** Error message when status is error. */
  error?: string;
  /** Raw pending representation. */
  raw?: string;
  /** Timing metadata. */
  time?: { start?: number; end?: number };
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
  /** Stable identity: `${providerID}/${modelID}`. */
  key: string;
  providerID: string;
  /** Provider display name, for grouping (e.g. "Anthropic"). */
  providerName: string;
  modelID: string;
  /** Model display name (e.g. "Claude Sonnet 4.6"). */
  name: string;
  /** Max context window in tokens (model.limit.context), if known. */
  contextLimit?: number;
  /**
   * Reasoning-effort variants the model supports, in the server's order
   * (e.g. `["low", "medium", "high", "xhigh", "max"]`). Empty when the model
   * has no selectable reasoning effort. Sent to the prompt endpoint as the
   * top-level `variant` string; omitting it uses the model's default.
   */
  variants: string[];
}

/** One MCP server's runtime status (from /mcp). */
export interface McpStatus {
  name: string;
  /** "connected" | "failed" | "disabled" | other server-reported state. */
  status: string;
  error?: string;
}

/** One LSP server's runtime status (from /lsp). */
export interface LspStatus {
  id: string;
  status?: string;
}

/** A selectable OpenCode agent / mode. */
export interface AgentOption {
  /** Agent name passed to `/session/{id}/prompt_async` as `agent`. */
  name: string;
  /** Agent classification: "primary" agents are the user-facing modes. */
  mode?: string;
  description?: string;
}

/** Context-window usage for the active session. */
export interface ContextInfo {
  used: number;
  max: number;
}
