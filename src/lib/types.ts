// ── Backend (Rust IPC) types — mirror src-tauri/src/{env,project,server}.rs ──

export interface ToolStatus {
  found: boolean;
  path: string | null;
  version: string | null;
}

export interface EnvReport {
  opencode: ToolStatus;
  git: ToolStatus;
  /** `gh` CLI — used for GitHub account authentication. */
  gh: ToolStatus;
}

export type WorkspaceKind = "Base" | "Worktree" | "QuickChat";

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
  /** PR pipeline autofix mode (backend-driven, persisted in the registry).
   *  Optional only so the browser mock's literals stay terse — the real
   *  backend always sends it; treat an absent value as "off". */
  autofix_mode?: AutofixMode;
  /** OpenCode session id the backend drives for this workspace, if registered. */
  session_id?: string | null;
  /** Set when this workspace was checked out from an existing PR. */
  pr_number?: number | null;
  pr_url?: string | null;
  /** A fork PR — read-only (no push/autofix back to the fork). */
  pr_is_fork?: boolean;
}

/** PR pipeline autofix mode. Persisted per-workspace in the Rust registry. */
export type AutofixMode = "off" | "auto" | "super";

/** High-level PR pipeline phase (backend-computed; mirrors supervisor::Phase). */
export type PipelinePhase =
  | "idle"
  | "running"
  | "passing"
  | "failing"
  | "fixing"
  | "awaiting_push"
  | "exhausted";

/** AI-generated session metadata (mirrors engine::GeneratedTitle): a display
 *  title plus a conventional branch name, from one model call. */
export interface GeneratedTitle {
  title: string;
  /** e.g. `feature/dark-mode-toggle`; null when the model gave no usable one. */
  branch: string | null;
}

/** Human label for a workspace: explicit name, else branch, else a fallback.
 *  Quick chats start unnamed (the AI titles them from the first message). */
export function workspaceLabel(w: Workspace): string {
  return (
    w.name ?? w.branch ?? (w.kind === "QuickChat" ? "Quick chat" : "workspace")
  );
}

export interface Project {
  id: string;
  name: string;
  root_path: string;
  default_branch: string | null;
  default_model_key: string | null;
  prompts: ProjectPrompts;
  /** GitHub account override (`"{host}/{login}"`); null = use auto-detected. */
  account_id: string | null;
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
  /** GitHub account override: "" clears it (auto-detect), an id sets it,
   *  undefined leaves it unchanged. */
  account_id?: string;
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

/** One CI check on a PR, normalized from `gh`'s statusCheckRollup. */
export interface PrCheck {
  name: string;
  /** Coarse bucket the UI colors by. */
  bucket: "success" | "failure" | "pending" | "skipped";
  /** Raw upstream state/conclusion (e.g. "IN_PROGRESS", "FAILURE"). */
  state: string;
  /** Link to the check's logs/details, when provided. */
  url: string | null;
  /** Owning workflow name (GitHub Actions only). */
  workflow: string | null;
}

/** A pull request's CI status for one branch (from `workspacePrStatus`). */
export interface PrStatus {
  number: number;
  url: string;
  /** "OPEN" | "MERGED" | "CLOSED". */
  state: string;
  head_branch: string;
  /** Head commit SHA — identifies which commit the checks belong to. */
  head_sha: string;
  checks: PrCheck[];
  /** Rollup over all checks. */
  rollup: "success" | "failure" | "pending" | "none";
}

// ── Backend-pushed event payloads (Tauri events; see src/lib/events.ts and the
//    Rust watcher.rs / supervisor.rs emitters). Field names are camelCase. ──

/** `workspace:git` — git state for one workspace. `changes` is populated only
 *  for the active workspace (the heavier query). */
export interface GitPayload {
  workspaceId: string;
  diffStat: DiffStat;
  changes: FileChange[] | null;
  /** The branch actually checked out — the agent may rename/switch branches,
   *  so this can differ from the registry's `Workspace.branch` until the
   *  backend persists the change. Absent on detached HEAD / non-git. */
  branch?: string | null;
}

/** `workspace:pr` — PR pipeline + autofix state for one workspace. */
/** One workspace's complete sidebar state, from `get_sidebar_snapshot` — the
 *  race-free mount seed the `workspace:*` events then apply deltas over. */
export interface SidebarWorkspace {
  workspaceId: string;
  diffStat: DiffStat;
  session: SessionPayload;
  pr: PrPayload;
}

export interface PrPayload {
  workspaceId: string;
  status: PrStatus | null;
  phase: PipelinePhase;
  attempts: number;
  mode: AutofixMode;
  error: string | null;
}

/** `workspace:session` — coarse chat/session state (drives indicators + sounds). */
export interface SessionPayload {
  workspaceId: string;
  /** "working" while the AI is actively running a turn, else "idle". */
  activity: "idle" | "working";
  /** A question is pending (a subset of `needsAttention`). */
  awaitingInput: boolean;
  /** Backend-computed: needs the user (pending question, or a finished/unseen
   *  turn). Cleared when the workspace becomes active. Drives the warning icon. */
  needsAttention: boolean;
  error: string | null;
}

/** `workspace:todos` — the active workspace's todo list. */
export interface TodosPayload {
  workspaceId: string;
  todos: Todo[];
}

/** `workspace:notify` — discrete notification signals (foundation for sounds). */
export interface NotifyPayload {
  workspaceId: string;
  kind: "turn_done" | "awaiting_input" | "pipeline_failed" | "pipeline_green";
}

// ── GitHub accounts, identity & review inbox ──
//    Backend: src-tauri/src/github/. Command returns + event payloads are
//    camelCase. Auth is via `gh`; data is over the GitHub API.

/** A connected GitHub account (public identity only — never the token). */
export interface Account {
  /** Stable id: "{host}/{login}", e.g. "github.com/octocat". */
  id: string;
  host: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  orgs: string[];
  /** True when authenticated and usable; false → re-auth needed. */
  active: boolean;
  /** Human-readable status detail when not active. */
  status: string | null;
}

/** Coarse CI rollup — mirrors PrStatus.rollup buckets. */
export type CiRollup = "success" | "failure" | "pending" | "none";

/** Why a PR is in the review inbox. */
export type ReviewReason = "review_requested" | "assigned";

/** One PR in the cross-repo review inbox (PRs awaiting your review). */
export interface ReviewInboxItem {
  /** Stable id: "{repo}#{number}". */
  id: string;
  accountId: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  authorAvatar: string | null;
  reason: ReviewReason;
  headRef: string;
  rollup: CiRollup;
  isDraft: boolean;
  updatedAt: string;
  /** projectId whose bound repo matches this PR (enables in-app checkout);
   *  null → open-on-GitHub only. */
  projectId: string | null;
}

/** One PR selectable in the "create workspace from PR" picker. */
export interface PrSummary {
  number: number;
  title: string;
  url: string;
  author: string;
  authorAvatar: string | null;
  repo: string;
  headRef: string;
  baseRef: string;
  isFork: boolean;
  isDraft: boolean;
  updatedAt: string;
  /** "mine" | "review_requested" | "assigned" — the picker groups by this. */
  bucket: "mine" | "review_requested" | "assigned";
}

/** `github:accounts` — the account list changed (add/remove/re-auth). */
export interface AccountsPayload {
  accounts: Account[];
}

/** `github:review_inbox` — full review-inbox snapshot (replace). */
export interface ReviewInboxPayload {
  items: ReviewInboxItem[];
  refreshedAt: number | null;
  error: string | null;
}

/** Phases of a backend-driven `gh auth login --web` flow. */
export type LoginPhase =
  "starting" | "awaitingCode" | "polling" | "success" | "failed";

/** `github:login` — one step of a device-flow login. `awaitingCode` carries
 *  `code`+`url`; `success` carries the new `account`; `failed` carries `error`. */
export interface GitHubLoginEvent {
  loginId: string;
  phase: LoginPhase;
  code: string | null;
  url: string | null;
  account: Account | null;
  error: string | null;
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
  /** "command" (user-defined) or "skill" (an opencode skill surfaced as one). */
  source?: string;
}

// ── New chat layer (Rust `chat` module) — mirrors src-tauri/src/chat/model.rs.
//    The frontend renders these normalized DTOs; it never sees ACP/OpenCode
//    shapes. Field names are camelCase (serde rename_all). ──

export type TurnStatus =
  | "queued"
  | "streaming"
  | "awaitingPermission"
  | "completed"
  | "cancelled"
  | "failed";

export type TurnOrigin = "user" | "slash" | "lifecycle" | "init" | "autofix";

export type BlockToolStatus = "pending" | "running" | "completed" | "failed";

/** A file edit surfaced by a tool call (ACP diff → rendered via DiffBody).
 *  The unified diff is synthesized on the frontend from old/new text. */
export interface DiffBlock {
  path: string;
  oldText: string | null;
  newText: string;
}

/** A file location a tool touched (ACP `ToolCallLocation`). */
export interface ToolLocation {
  path: string;
  line: number | null;
}

/** A tool-call block. When `type: "tool"`, these fields are flattened in. */
export interface ToolBlock {
  blockId: string;
  callId: string;
  /** Normalized tool name (e.g. "edit", "bash", "read"). */
  name: string;
  title: string | null;
  status: BlockToolStatus;
  input: unknown;
  output: string | null;
  diff: DiffBlock | null;
  /** File locations reported by the tool. Optional: absent in old entries. */
  locations?: ToolLocation[];
  /** The tool's structured result (ACP raw_output), e.g. exit codes. */
  rawOutput?: unknown;
  /** Local receipt timestamps — drive the per-step duration. */
  startedAt?: number | null;
  endedAt?: number | null;
}

/** One rendered unit inside an assistant turn; discriminated by `type`. */
export type Block =
  | { type: "text"; blockId: string; text: string }
  | { type: "reasoning"; blockId: string; text: string }
  | ({ type: "tool" } & ToolBlock)
  | {
      type: "file";
      blockId: string;
      name: string | null;
      mime: string | null;
      url: string;
    };

/** Deterministic collapse summary for a finished assistant turn. */
export interface CollapseSummary {
  collapsed: boolean;
  stepCount: number;
  filesEdited: string[];
  commandsRun: number;
  headline: string;
}

export interface ChatAttachment {
  mime: string;
  url: string;
  filename: string | null;
}

export interface UsageInfo {
  input?: number | null;
  output?: number | null;
  reasoning?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
}

export interface UserEntry {
  type: "user";
  seq: number;
  entryId: string;
  /** What the UI shows. */
  display: string;
  /** What was actually sent to the AI (differs for slash/lifecycle/init/skills). */
  sent: string;
  attachments: ChatAttachment[];
  model: string | null;
  variant: string | null;
  agent: string | null;
  origin: TurnOrigin;
  createdAt: number;
}

export interface AssistantEntry {
  type: "assistant";
  seq: number;
  entryId: string;
  engineSessionId: number | null;
  status: TurnStatus;
  origin: TurnOrigin;
  blocks: Block[];
  summary: CollapseSummary;
  usage: UsageInfo | null;
  startedAt: number;
  endedAt: number | null;
}

export interface SystemEntry {
  type: "system";
  seq: number;
  entryId: string;
  kind: "info" | "success" | "error";
  text: string;
  createdAt: number;
}

/** One item in a conversation timeline; discriminated by `type`. */
export type Entry = UserEntry | AssistantEntry | SystemEntry;

/** A selectable choice within a config option. */
export interface ConfigChoice {
  value: string;
  name: string;
  description: string | null;
  group: string | null;
}

/** A session config option — drives the model / reasoning / mode selectors.
 *  `category` is "model" | "thoughtLevel" | "mode" | "modelConfig" | other. */
export interface ConfigOption {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  currentValue: string;
  choices: ConfigChoice[];
}

/** The initial payload loaded on mount / paged for history. */
export interface ChatSnapshot {
  conversationId: string;
  entries: Entry[];
  headSeq: number;
  hasMore: boolean;
  config: ConfigOption[];
  /** Slash commands / skills advertised by the engine (seeded so a re-mount
   *  keeps them even though the engine only pushes `chat:commands` once). */
  commands: ChatCommand[];
}

// ── chat:* event payloads (see src/lib/events.ts) ──

export interface ChatEntryEvent {
  workspaceId: string;
  entry: Entry;
}

export interface ChatBlockEvent {
  workspaceId: string;
  entrySeq: number;
  block: Block;
  /** Incremental text to append (streaming); null = replace the whole block. */
  textAppend: string | null;
}

export interface ChatTurnEvent {
  workspaceId: string;
  entrySeq: number;
  status: TurnStatus;
  summary: CollapseSummary;
  usage: UsageInfo | null;
  /** Set when the turn reached a terminal status (live duration footer). */
  endedAt?: number | null;
}

export interface ChatPermChoice {
  optionId: string;
  name: string;
  /** "allowOnce" | "allowAlways" | "rejectOnce" | "rejectAlways". */
  kind: string;
}

export interface ChatPermissionEvent {
  workspaceId: string;
  entrySeq: number;
  requestId: string;
  toolCallId: string;
  title: string | null;
  options: ChatPermChoice[];
}

export interface ChatConfigEvent {
  workspaceId: string;
  options: ConfigOption[];
}

export interface ChatResetEvent {
  workspaceId: string;
}

export interface ChatContextEvent {
  workspaceId: string;
  used: number;
  max: number;
}

export interface ChatCommand {
  name: string;
  description: string;
}

export interface ChatCommandsEvent {
  workspaceId: string;
  commands: ChatCommand[];
}

/** Runtime MCP + LSP status for a workspace (supplemental `opencode serve`). */
export interface ToolsStatus {
  mcp: McpStatus[];
  lsp: LspStatus[];
}
