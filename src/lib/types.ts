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
  /** Prompt sent to the AI once the workspace server is ready. */
  init_prompt: string | null;
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
  default_model_key: string | null;
  prompts: ProjectPrompts;
}

export interface ProjectPrompts {
  init_workspace: string | null;
  commit: string | null;
  merge: string | null;
  push: string | null;
  create_pr: string | null;
}

export interface ProjectUpdate {
  name?: string;
  default_branch?: string;
  default_model_key?: string | null;
  prompts?: ProjectPrompts;
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

export interface RemoteInfo {
  name: string;
  url: string;
}

export interface MergeResult {
  branch: string;
  base: string;
  summary: string;
}

export interface PushResult {
  branch: string;
  remote: string;
  output: string;
}

export interface PrResult {
  branch: string;
  base: string;
  url: string;
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
  /** Token usage for this message (assistant messages may include this). */
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
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
  /** MIME type for file parts. */
  mime?: string;
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
  /**
   * Tool-specific extras. Edit/Write set:
   *  - `diff`: full unified diff of the change (use over synthesized diffs).
   *  - `diagnostics`: { [absPath]: LspDiagnostic[] } LSP results post-edit.
   *  - `filediff`: `{ file, patch }`, `truncated`: boolean.
   */
  metadata?: Record<string, unknown>;
}

/** Subset of an LSP Diagnostic we render. */
export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** LSP severity: 1=error, 2=warning, 3=info, 4=hint. */
  severity?: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
  code?: string | number;
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

/** One OpenCode todo item from /session/{id}/todo. */
export interface Todo {
  content: string;
  /** "pending" | "in_progress" | "completed" | "cancelled" */
  status: string;
  priority: string;
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

/** One slash command from OpenCode's `/command` endpoint.
 *
 * Slash commands are client-side prompt templates: the client expands
 * `$ARGUMENTS` in `template` with the user-supplied text and sends the result
 * as a normal prompt. There is no dedicated server execution endpoint. */
export interface CommandOption {
  /** Identifier the user types after `/` (e.g. "review"). */
  name: string;
  description?: string;
  /** Prompt body, may contain `$ARGUMENTS` placeholders. */
  template: string;
  /** "command" (user-defined) or "skill" (an opencode skill surfaced as one). */
  source?: string;
  /** Run as a sub-agent (delegated task) instead of in the user's current mode. */
  subtask?: boolean;
}
