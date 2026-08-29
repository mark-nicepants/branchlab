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

type WorkspaceKind = "Base" | "Worktree" | "QuickChat";

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
  /** Set when this workspace was checked out from an existing PR. */
  pr_number?: number | null;
  /** A fork PR — read-only (no push/autofix back to the fork). */
  pr_is_fork?: boolean;
  /** Background provisioning state (creation returns before setup finishes). */
  setup: SetupState;
}

/** Workspace provisioning state (serde lowercase enum). */
export type SetupState = "ready" | "provisioning" | "failed";

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
  prompts: ProjectPrompts;
  run: RunSettings;
  /** GitHub account override (`"{host}/{login}"`); null = use auto-detected. */
  account_id: string | null;
  /** Estimate-unit override; null = use the board's global unit. */
  estimate_unit: EstimateUnit | null;
}

/** Per-project workspace setup/teardown scripts (snake_case on the wire). */
export interface RunSettings {
  setup_script: string | null;
  teardown_script: string | null;
}

/** AI-proposed lifecycle scripts (fills the Scripts form for review). */
export interface GeneratedSetup {
  setup_script: string | null;
  teardown_script: string | null;
  notes: string | null;
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
  prompts?: ProjectPrompts;
  /** Whole-block replace, like `prompts`. */
  run?: RunSettings;
  /** GitHub account override: "" clears it (auto-detect), an id sets it,
   *  undefined leaves it unchanged. */
  account_id?: string;
  /** Estimate-unit override: null clears it (back to the board's global
   *  unit), a value sets it, OMITTED (not undefined-assigned) = unchanged. */
  estimate_unit?: EstimateUnit | null;
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

/** A pull request's CI status for one branch. */
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

/** `workspace:setup` — workspace provisioning progress. `ok` is null while
 *  running. */
export interface WorkspaceSetupPayload {
  workspaceId: string;
  running: boolean;
  ok: boolean | null;
}

/** `workspace:todos` — the active workspace's todo list. */
export interface TodosPayload {
  workspaceId: string;
  todos: Todo[];
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
  /** True when authenticated and usable; false → re-auth needed. */
  active: boolean;
  /** Human-readable status detail when not active. */
  status: string | null;
}

/** Coarse CI rollup — mirrors PrStatus.rollup buckets. */
export type CiRollup = "success" | "failure" | "pending" | "none";

/** Why a PR is in the review inbox. */
type ReviewReason = "review_requested" | "assigned";

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

/** One OpenCode todo item from /session/{id}/todo. */
export interface Todo {
  content: string;
  /** "pending" | "in_progress" | "completed" | "cancelled" */
  status: string;
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

// ── New chat layer (Rust `chat` module) — mirrors src-tauri/src/chat/model.rs.
//    The frontend renders these normalized DTOs; it never sees ACP/OpenCode
//    shapes. Field names are camelCase (serde rename_all). ──

type TurnStatus =
  | "queued"
  | "streaming"
  | "awaitingPermission"
  | "completed"
  | "cancelled"
  | "failed";

type TurnOrigin =
  | "user"
  | "slash"
  | "lifecycle"
  | "init"
  | "autofix"
  | "task";

type BlockToolStatus = "pending" | "running" | "completed" | "failed";

/** A file edit surfaced by a tool call (ACP diff → rendered via DiffBody).
 *  The unified diff is synthesized on the frontend from old/new text. */
export interface DiffBlock {
  path: string;
  oldText: string | null;
  newText: string;
}

/** A file location a tool touched (ACP `ToolCallLocation`). */
interface ToolLocation {
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
interface CollapseSummary {
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

interface UsageInfo {
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
  /** Workspace-setup progress steps; empty for plain notices. */
  steps: SetupStep[];
  /** Optional action button on the notice (e.g. delete after PR merge). */
  action?: "deleteWorkspace" | null;
  createdAt: number;
}

/** One step of the workspace setup card (updated via `chat:entry` upserts). */
export interface SetupStep {
  label: string;
  status: BlockToolStatus;
  log: string[];
  startedAt: number | null;
  endedAt: number | null;
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
  entries: Entry[];
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
  /** The full authoritative block — upsert by blockId (idempotent: duplicate
   *  or reordered deliveries cannot corrupt the rendered text). */
  block: Block;
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

interface ChatPermChoice {
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

// ── "My work" task board (src-tauri/src/tasks.rs) ──

export type ColumnRole = "none" | "queued" | "active" | "review" | "done";

export interface BoardColumn {
  id: string;
  name: string;
  role: ColumnRole;
  position: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** A file attached to a task (mirrors tasks::TaskAttachment). The bytes
 *  live in app data; the frontend opens them via `taskAttachmentPath`. */
export interface TaskAttachment {
  id: string;
  name: string;
  size: number;
  createdAt: number;
}

export interface Task {
  id: string;
  /** Human reference (#7): incremental, never reused. */
  number: number;
  title: string;
  description: string | null;
  projectId: string | null;
  columnId: string;
  position: number;
  /** Linked session; cleared when that workspace is deleted. */
  workspaceId: string | null;
  /** Subtask hierarchy (v2 UI); the main board shows only parentless tasks. */
  parentId: string | null;
  /** Queued dispatch waits until every dependency is in the done column. */
  dependsOn: string[];
  /** Size estimate, read in the configured unit (see EstimateUnit);
   *  null = unset. */
  estimate: number | null;
  /** Files attached to the task (visible to agent sessions/MCP). */
  attachments: TaskAttachment[];
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** How estimates are read: story points (default), hours, or t-shirt sizes
 *  (stored as their numeric value). Board-global with a per-project override
 *  on `Project.estimate_unit`. */
export type EstimateUnit = "points" | "hours" | "tshirt";

/** T-shirt sizes and the numbers they're stored as. */
export const TSHIRT_SIZES = [
  { label: "XS", value: 1 },
  { label: "S", value: 2 },
  { label: "M", value: 3 },
  { label: "L", value: 5 },
  { label: "XL", value: 8 },
] as const;

/** Nearest t-shirt size for a stored estimate (values may be non-exact,
 *  e.g. from an imported GitHub issue). Ties round up to the larger size. */
export function nearestTshirt(value: number): (typeof TSHIRT_SIZES)[number] {
  return TSHIRT_SIZES.reduce((best, s) =>
    Math.abs(s.value - value) <= Math.abs(best.value - value) ? s : best,
  );
}

/** Compact unit-silent display: bare number, or size letters for t-shirt. */
export function formatEstimate(value: number, unit: EstimateUnit): string {
  return unit === "tshirt" ? nearestTshirt(value).label : String(value);
}

/** Live board state (`board_snapshot` seed + every `tasks:changed` event). */
export interface BoardSnapshot {
  columns: BoardColumn[];
  tasks: Task[];
  /** Board-global estimate unit (projects can override). */
  estimateUnit: EstimateUnit;
}

/** One line in a task's activity feed (mirrors tasks::ActivityEntry).
 *  `kind` is "comment" (user prose), "command" (a /slash comment), or a
 *  recorded event: created | session | review | resumed | moved | done | plan. */
export interface ActivityEntry {
  id: string;
  taskId: string;
  kind: string;
  /** Comment text, or a short event detail ("In progress", "PR #57 merged"). */
  body: string;
  actor: "user" | "agent" | "ai";
  createdAt: number;
}

/** A task whose workspace link was severed by a deletion — offer "mark done". */
export interface UnlinkedTask {
  taskId: string;
  title: string;
}

/** An open GitHub issue (the task board's import picker). */
export interface IssueSummary {
  number: number;
  title: string;
  body: string | null;
  url: string;
  author: string;
  /** RFC3339; the picker lists newest-updated first. */
  updatedAt: string;
  /** "Estimate" number from a GitHub Projects v2 board — best-effort. */
  estimate: number | null;
}

/** `task_suggest_plan` result: AI-applied ordering + estimates. */
export interface SuggestedPlan {
  updated: number;
  notes: string | null;
}

/** `workspace:notify` — attention taps (turn done / awaiting input /
 *  task ready for review). `taskTitle` is set for task_review. */
export interface NotifyPayload {
  workspaceId: string;
  kind: "turn_done" | "awaiting_input" | "task_review";
  taskTitle?: string | null;
}
