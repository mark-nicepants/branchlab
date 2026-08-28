// "My work" — a lightweight kanban board over the backend TaskStore
// (src-tauri/src/tasks.rs). Local state seeds from `boardSnapshot()` and every
// mutation comes back authoritatively via the `tasks:changed` event; drags
// apply optimistically in between. Ordering uses fractional positions — the
// frontend computes midpoints, the backend renumbers when gaps exhaust.
//
// Subtasks: a task with live children is a "parent" — its card shows a
// status-colored subtask bar, and clicking that bar drills down to a board of
// just its children (clicking the card itself opens the edit dialog, like any
// card). The backend never dispatches parents; children carry `dependsOn`
// chains ("Suggest plan" asks the AI to order + estimate them).
//
// HTML5 drag-and-drop requires `dragDropEnabled: false` on the Tauri window
// (tauri.conf.json) — with it on, WKWebView's native file-drop interception
// swallows every dragover/drop inside the webview.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  ChevronLeft,
  Circle,
  CircleCheck,
  CircleDot,
  Clock,
  CloudDownload,
  GitPullRequest,
  ListFilter,
  Loader2,
  Lock,
  MessageSquare,
  PanelTop,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Triangle,
  Undo2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import {
  boardSnapshot,
  chatArchive,
  listProjectIssues,
  taskActivity,
  taskComment,
  taskCreate,
  taskDelete,
  taskMove,
  taskSuggestPlan,
  taskUpdate,
} from "../../lib/api";
import { onTasksChanged } from "../../lib/events";
import { formatEstimate, TSHIRT_SIZES } from "../../lib/types";
import type {
  ActivityEntry,
  BoardColumn,
  ColumnRole,
  DiffStat,
  Entry,
  EstimateUnit,
  IssueSummary,
  BoardSnapshot,
  PrPayload,
  PrStatus,
  ProjectView,
  SessionPayload,
  Task,
  Workspace,
} from "../../lib/types";
import { useWorkspaceData } from "../../hooks/useWorkspaceData";
import { hasOpenOverlay } from "../session/SessionView";
import {
  AssistantTurnView,
  SystemMessageView,
  UserMessageView,
} from "../ChatMessage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface Props {
  projects: ProjectView[];
  /** Quick chats live outside projects but can be linked to tasks too. */
  quickChats: Workspace[];
  onOpenSession: (workspaceId: string) => void;
  /** Spawn a session for this task (App links the workspace back to it). */
  onStartTask: (task: Task) => void;
  /** Delete a task's workspace (the done-column cleanup offer). */
  onCleanupWorkspace: (workspaceId: string) => void;
  /** Focus this card on mount (the session header's task chip jump). */
  focusTaskId: string | null;
  onFocusTaskHandled: () => void;
}

/** Where a dragged card would land: before `before`, or at the end (null). */
interface DropSpot {
  columnId: string;
  before: string | null;
}

/** Create-or-edit dialog state. */
type DialogState =
  | { mode: "create"; columnId: string; parentId?: string | null }
  | { mode: "edit"; task: Task };

/** Fractional index for inserting before `next` in a sorted sibling list. */
function positionBefore(sorted: Task[], next: Task | null): number {
  if (!next) {
    const last = sorted[sorted.length - 1];
    return (last?.position ?? 0) + 1024;
  }
  const i = sorted.findIndex((t) => t.id === next.id);
  const prev = sorted[i - 1];
  return prev ? (prev.position + next.position) / 2 : next.position / 2;
}

// ── Card state model (GitHub-Projects-style glyphs + chips) ────────────────

/** The lifecycle state a card renders as, derived from column role + link. */
type CardState = "todo" | "queued" | "working" | "review" | "done";

function deriveState(task: Task, role: ColumnRole): CardState {
  if (role === "done") return "done";
  if (role === "review") return "review";
  if (role === "active") return task.workspaceId ? "working" : "queued";
  return "todo";
}

// GitHub's PR/review purple has no theme token — a deliberate one-off.
const REVIEW_TEXT = "text-[#a371f7]";
const REVIEW_BORDER = "border-[#a371f7]/45";

/** Shared pill styling for the tiny status/PR/dep chips. */
const CHIP =
  "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]";

/** Board-wide lookups the cards need for parent/dependency rendering. */
interface BoardCtx {
  taskById: Map<string, Task>;
  /** Live children keyed by parent id (only parents with children appear). */
  childrenByParent: Map<string, Task[]>;
  roleById: Map<string, ColumnRole>;
}

const byNumber = (a: Task, b: Task) => a.number - b.number;

/** First dependency that still exists and hasn't reached a done column. */
function firstUnmetDep(task: Task, ctx: BoardCtx): Task | null {
  for (const id of task.dependsOn) {
    const dep = ctx.taskById.get(id);
    if (dep && ctx.roleById.get(dep.columnId) !== "done") return dep;
  }
  return null;
}

/** 13px GitHub-style state glyph (open / clock / dot / check circle). */
function StateIcon({
  state,
  className,
}: {
  state: CardState;
  className?: string;
}) {
  const cls = cn(
    "size-[13px] shrink-0",
    {
      todo: "text-muted-foreground",
      queued: "text-muted-foreground",
      working: "text-warning",
      review: REVIEW_TEXT,
      done: "text-additions",
    }[state],
    className,
  );
  const svg = { viewBox: "0 0 16 16", fill: "none", className: cls } as const;
  const stroke = {
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  switch (state) {
    case "todo":
      return (
        <svg {...svg} aria-label="todo">
          <circle cx="8" cy="8" r="6.2" {...stroke} />
        </svg>
      );
    case "queued":
      return (
        <svg {...svg} aria-label="queued">
          <circle cx="8" cy="8" r="6.2" {...stroke} />
          <path d="M8 5v3l2 1.5" {...stroke} />
        </svg>
      );
    case "working":
      return (
        <svg {...svg} aria-label="in progress">
          <circle cx="8" cy="8" r="6.2" {...stroke} />
          <circle cx="8" cy="8" r="2.7" fill="currentColor" />
        </svg>
      );
    case "review":
      return (
        <svg {...svg} aria-label="in review">
          <circle cx="8" cy="8" r="6.2" {...stroke} />
          <path d="M5.4 8.3l1.8 1.8 3.4-3.9" {...stroke} />
        </svg>
      );
    case "done":
      return (
        <svg {...svg} aria-label="done">
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5.2 8.3l1.9 1.9 3.7-4.1"
            {...stroke}
            stroke="var(--background)"
          />
        </svg>
      );
  }
}

export function MyWorkScreen({
  projects,
  quickChats,
  onOpenSession,
  onStartTask,
  onCleanupWorkspace,
  focusTaskId,
  onFocusTaskHandled,
}: Props) {
  const [board, setBoard] = useState<BoardSnapshot>({
    columns: [],
    tasks: [],
    estimateUnit: "points",
  });
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [archiveFor, setArchiveFor] = useState<Task | null>(null);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropSpot, setDropSpot] = useState<DropSpot | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** When set, the board shows only this parent's children (drill-down). */
  const [drillParentId, setDrillParentId] = useState<string | null>(null);
  const { sessionByWorkspace, prByWorkspace, diffStats } = useWorkspaceData();

  // Arriving from a session's task chip: focus + reveal that card (drilling
  // into its parent if it's a subtask, back to the main board otherwise).
  useEffect(() => {
    if (!focusTaskId) return;
    const target = board.tasks.find((t) => t.id === focusTaskId);
    setDrillParentId(target?.parentId ?? null);
    setFocusedId(focusTaskId);
    onFocusTaskHandled();
  }, [focusTaskId, onFocusTaskHandled, board.tasks]);

  useEffect(() => {
    let live = true;
    void boardSnapshot().then((s) => live && setBoard(s));
    // Fresh closure per mount: the mock event bus stores handlers in a Set,
    // so passing the stable setter would let StrictMode's first-unmount
    // cleanup delete the second mount's identical subscription.
    const unlisten = onTasksChanged((s) => setBoard(s));
    return () => {
      live = false;
      void unlisten.then((f) => f());
    };
  }, []);

  const allWorkspaces = useMemo(
    () =>
      new Map(
        [...projects.flatMap((p) => p.workspaces), ...quickChats].map((w) => [
          w.id,
          w,
        ]),
      ),
    [projects, quickChats],
  );
  const projectNames = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects],
  );
  const boardCtx = useMemo<BoardCtx>(() => {
    const childrenByParent = new Map<string, Task[]>();
    for (const t of board.tasks) {
      if (!t.parentId) continue;
      const list = childrenByParent.get(t.parentId);
      if (list) list.push(t);
      else childrenByParent.set(t.parentId, [t]);
    }
    return {
      taskById: new Map(board.tasks.map((t) => [t.id, t])),
      childrenByParent,
      roleById: new Map(board.columns.map((c) => [c.id, c.role])),
    };
  }, [board]);
  // Filter chips: only projects that actually have cards.
  const filterProjects = useMemo(
    () => projects.filter((p) => board.tasks.some((t) => t.projectId === p.id)),
    [projects, board.tasks],
  );
  const visibleTasks = useMemo(
    () =>
      board.tasks.filter((t) =>
        drillParentId
          ? // Drill-down: only this parent's children, no project filter.
            t.parentId === drillParentId
          : // Main board: subtasks render in their parent's drill-down.
            t.parentId === null &&
            (projectFilter === null || t.projectId === projectFilter),
      ),
    [board.tasks, projectFilter, drillParentId],
  );
  /** Visible tasks per column, in board order (the keyboard grid). */
  const grid = useMemo(
    () =>
      board.columns.map((c) =>
        visibleTasks.filter((t) => t.columnId === c.id),
      ),
    [board.columns, visibleTasks],
  );

  const drillParent = drillParentId
    ? (boardCtx.taskById.get(drillParentId) ?? null)
    : null;
  // Leave the drill-down when its parent disappears (deleted elsewhere).
  useEffect(() => {
    if (drillParentId && board.tasks.length > 0 && !drillParent)
      setDrillParentId(null);
  }, [drillParentId, drillParent, board.tasks.length]);

  const moveTask = useCallback(
    (taskId: string, columnId: string, position: number) => {
      // Landing a card with a live session in Done: promote cleaning up the
      // workspace (the chat stays available on the card afterwards).
      const target = board.columns.find((c) => c.id === columnId);
      const task = board.tasks.find((t) => t.id === taskId);
      const ws = task?.workspaceId ? allWorkspaces.get(task.workspaceId) : null;
      if (target?.role === "done" && task && task.columnId !== columnId && ws) {
        toast(`"${task.title}" is done`, {
          description: "Clean up its workspace? The chat stays on the card.",
          duration: 10_000,
          action: {
            label: "Delete workspace",
            onClick: () => onCleanupWorkspace(ws.id),
          },
        });
      }
      // Optimistic: the authoritative snapshot follows via tasks:changed.
      setBoard((prev) => ({
        ...prev,
        tasks: prev.tasks
          .map((t) => (t.id === taskId ? { ...t, columnId, position } : t))
          .sort((a, b) => a.position - b.position),
      }));
      taskMove(taskId, columnId, position).catch((e) =>
        toast.error("Could not move task", { description: String(e) }),
      );
    },
    [board.columns, board.tasks, allWorkspaces, onCleanupWorkspace],
  );

  // Parents whose children all landed in Done: offer moving the parent there
  // too (once per parent per app session — declining shouldn't nag).
  const offeredDone = useRef(new Set<string>());
  useEffect(() => {
    const doneIds = new Set(
      board.columns.filter((c) => c.role === "done").map((c) => c.id),
    );
    if (doneIds.size === 0) return;
    const doneCol = board.columns.find((c) => c.role === "done")!;
    for (const parent of board.tasks) {
      if (parent.parentId !== null || doneIds.has(parent.columnId)) continue;
      const kids = board.tasks.filter((t) => t.parentId === parent.id);
      if (kids.length === 0 || !kids.every((k) => doneIds.has(k.columnId)))
        continue;
      if (offeredDone.current.has(parent.id)) continue;
      offeredDone.current.add(parent.id);
      const end =
        Math.max(
          0,
          ...board.tasks
            .filter((t) => t.columnId === doneCol.id)
            .map((t) => t.position),
        ) + 1024;
      toast(`All subtasks of #${parent.number} done`, {
        description: `Move "${parent.title}" to Done?`,
        duration: 10_000,
        action: {
          label: "Move to Done",
          onClick: () =>
            taskMove(parent.id, doneCol.id, end).catch((e) =>
              toast.error("Could not move task", { description: String(e) }),
            ),
        },
      });
    }
  }, [board]);

  const quickAddSubtask = useCallback(
    (title: string, columnId: string) => {
      if (!drillParentId) return;
      taskCreate(title, { parentId: drillParentId, columnId }).catch((e) =>
        toast.error("Could not add subtask", { description: String(e) }),
      );
    },
    [drillParentId],
  );

  // ── Keyboard: N = new task; arrows move card focus; Space/Enter opens;
  //    Esc leaves a drill-down. ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        hasOpenOverlay() ||
        dialog !== null ||
        target?.closest("input, textarea, [contenteditable=true]")
      ) {
        return;
      }
      if (e.key === "Escape") {
        if (drillParentId) {
          e.preventDefault();
          setDrillParentId(null);
        }
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        const first = board.columns[0];
        if (first)
          setDialog({
            mode: "create",
            columnId: first.id,
            parentId: drillParentId,
          });
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if ((e.key === "f" || e.key === "F") && !drillParentId) {
        // The filter dropdown only exists on the main board's header.
        e.preventDefault();
        setFilterOpen(true);
        return;
      }
      const nav = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
      const isOpenKey = e.key === " " || e.key === "Enter";
      if (!nav.includes(e.key) && !isOpenKey) return;

      let ci = grid.findIndex((col) => col.some((t) => t.id === focusedId));
      let ri = ci >= 0 ? grid[ci].findIndex((t) => t.id === focusedId) : -1;

      if (isOpenKey) {
        if (ci >= 0) {
          e.preventDefault();
          // Every card opens its dialog; the subtask bar drills into parents.
          setDialog({ mode: "edit", task: grid[ci][ri] });
        }
        return;
      }
      e.preventDefault();
      if (ci < 0) {
        // Nothing focused: land on the first card of the first non-empty column.
        ci = grid.findIndex((col) => col.length > 0);
        if (ci < 0) return;
        setFocusedId(grid[ci][0].id);
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        ri = Math.min(
          Math.max(ri + (e.key === "ArrowDown" ? 1 : -1), 0),
          grid[ci].length - 1,
        );
      } else {
        // Left/right: nearest non-empty column in that direction, same row.
        const dir = e.key === "ArrowRight" ? 1 : -1;
        let next = ci + dir;
        while (next >= 0 && next < grid.length && grid[next].length === 0)
          next += dir;
        if (next < 0 || next >= grid.length) return;
        ci = next;
        ri = Math.min(ri, grid[ci].length - 1);
      }
      setFocusedId(grid[ci][ri].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [grid, focusedId, dialog, board.columns, drillParentId]);

  const drillChildren = drillParentId
    ? (boardCtx.childrenByParent.get(drillParentId) ?? [])
    : [];
  const drillDone = drillChildren.filter(
    (t) => boardCtx.roleById.get(t.columnId) === "done",
  ).length;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* One compact title row doubling as the traffic-light drag region. */}
      {drillParent ? (
        <div
          data-tauri-drag-region
          className="flex h-14 shrink-0 items-center gap-2 px-6 pt-2"
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDrillParentId(null)}
            className="gap-1 px-2 text-muted-foreground hover:text-foreground"
            title="Back to the board (Esc)"
          >
            <ChevronLeft className="size-4" />
            My work
          </Button>
          <h1 className="min-w-0 truncate text-lg font-semibold">
            <span className="mr-2 font-mono text-sm font-normal text-muted-foreground">
              #{drillParent.number}
            </span>
            {drillParent.title}
          </h1>
          <div data-tauri-drag-region className="flex-1" />
          <span className="shrink-0 text-xs text-muted-foreground">
            {drillDone} of {drillChildren.length} done
          </span>
        </div>
      ) : (
        <div
          data-tauri-drag-region
          className="flex h-14 shrink-0 items-center gap-3 px-6 pt-2"
        >
          <h1 className="text-lg font-semibold">My work</h1>
          <div data-tauri-drag-region className="flex-1" />
          <DropdownMenu open={filterOpen} onOpenChange={setFilterOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "gap-1.5 px-2",
                  projectFilter !== null
                    ? "text-primary hover:text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
                title="Filter tasks"
              >
                <ListFilter className="size-4" />
                {projectFilter !== null && (
                  <span className="max-w-40 truncate text-xs">
                    {projectNames.get(projectFilter) ?? "Project"}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Project</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={projectFilter ?? "all"}
                onValueChange={(v) =>
                  setProjectFilter(v === "all" ? null : v)
                }
              >
                <DropdownMenuRadioItem value="all">
                  All projects
                </DropdownMenuRadioItem>
                {filterProjects.map((p) => (
                  <DropdownMenuRadioItem key={p.id} value={p.id}>
                    <span className="truncate">{p.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* Horizontal padding lives on the inner track: end-padding on a
          scroll container is swallowed at the scroll edge. */}
      <div className="min-h-0 flex-1 overflow-x-auto pb-6">
        <div className="flex h-full w-max min-w-full items-stretch gap-4 px-6">
          {board.columns.map((col, i) => (
            <BoardColumnView
              key={col.id}
              column={col}
              tasks={grid[i]}
              ctx={boardCtx}
              projectNames={projectNames}
              workspaces={allWorkspaces}
              sessions={sessionByWorkspace}
              prs={prByWorkspace}
              diffStats={diffStats}
              dragTaskId={dragTaskId}
              dropSpot={dropSpot?.columnId === col.id ? dropSpot : null}
              focusedId={focusedId}
              onDragStateChange={(taskId, spot) => {
                if (taskId !== undefined) setDragTaskId(taskId);
                if (spot !== undefined) setDropSpot(spot);
              }}
              onMoveTask={moveTask}
              onEdit={(t) => setDialog({ mode: "edit", task: t })}
              onAdd={() => setDialog({ mode: "create", columnId: col.id })}
              onQuickAdd={
                drillParentId
                  ? (title) => quickAddSubtask(title, col.id)
                  : undefined
              }
              onOpenArchive={setArchiveFor}
              onFocus={setFocusedId}
              onDrill={setDrillParentId}
              onStartTask={onStartTask}
              onOpenSession={onOpenSession}
            />
          ))}
        </div>
      </div>

      {dialog?.mode === "create" && (
        <TaskCreateDialog
          state={dialog}
          projects={projects}
          ctx={boardCtx}
          columns={board.columns}
          boardUnit={board.estimateUnit}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.mode === "edit" && (
        <TaskEditDialog
          // Keyed by task id so switching to a parent/subtask resets all
          // dialog-local state (drafts, pickers, activity feed).
          key={dialog.task.id}
          // Re-resolve on every snapshot so per-field commits render back live.
          task={boardCtx.taskById.get(dialog.task.id) ?? dialog.task}
          ctx={boardCtx}
          boardUnit={board.estimateUnit}
          projects={projects}
          columns={board.columns}
          workspaces={allWorkspaces}
          sessions={sessionByWorkspace}
          prs={prByWorkspace}
          diffStats={diffStats}
          onOpenSession={onOpenSession}
          onStartTask={onStartTask}
          onSwitchTask={(t) => setDialog({ mode: "edit", task: t })}
          onShowShortcuts={() => setShortcutsOpen(true)}
          onClose={() => setDialog(null)}
        />
      )}
      {shortcutsOpen && (
        <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />
      )}
      {archiveFor && (
        <ArchiveDialog task={archiveFor} onClose={() => setArchiveFor(null)} />
      )}
    </div>
  );
}


/** A 2px insertion line shown at the drop position while dragging. */
function DropLine() {
  return <div className="h-0.5 shrink-0 rounded-full bg-primary" />;
}

function BoardColumnView({
  column,
  tasks,
  ctx,
  projectNames,
  workspaces,
  sessions,
  prs,
  diffStats,
  dragTaskId,
  dropSpot,
  focusedId,
  onDragStateChange,
  onMoveTask,
  onEdit,
  onAdd,
  onQuickAdd,
  onFocus,
  onDrill,
  onStartTask,
  onOpenSession,
  onOpenArchive,
}: {
  column: BoardColumn;
  tasks: Task[];
  ctx: BoardCtx;
  projectNames: Map<string, string>;
  workspaces: Map<string, Workspace>;
  sessions: Record<string, SessionPayload>;
  prs: Record<string, PrPayload>;
  diffStats: Record<string, DiffStat>;
  dragTaskId: string | null;
  dropSpot: DropSpot | null;
  focusedId: string | null;
  onDragStateChange: (taskId?: string | null, spot?: DropSpot | null) => void;
  onMoveTask: (taskId: string, columnId: string, position: number) => void;
  onEdit: (t: Task) => void;
  onAdd: () => void;
  /** Drill-down quick-add: creates a subtask in this column (replaces onAdd). */
  onQuickAdd?: (title: string) => void;
  onFocus: (id: string) => void;
  onDrill: (id: string) => void;
  onStartTask: (t: Task) => void;
  onOpenSession: (workspaceId: string) => void;
  onOpenArchive: (t: Task) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  /** The card the pointer is above (insert before it; null = end). */
  const dropBefore = (clientY: number): Task | null => {
    const cards =
      listRef.current?.querySelectorAll<HTMLElement>("[data-task-id]");
    for (const el of cards ?? []) {
      if (el.dataset.taskId === dragTaskId) continue;
      const r = el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        const id = el.dataset.taskId;
        return tasks.find((t) => t.id === id) ?? null;
      }
    }
    return null;
  };

  return (
    <div
      className={cn(
        "group/column flex h-full w-[280px] shrink-0 flex-col rounded-lg border bg-card/50",
        dropSpot ? "border-primary/50" : "border-border",
      )}
      onDragOver={(e) => {
        if (!dragTaskId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const before = dropBefore(e.clientY);
        onDragStateChange(undefined, {
          columnId: column.id,
          before: before?.id ?? null,
        });
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        onDragStateChange(undefined, null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const taskId = e.dataTransfer.getData("text/plain") || dragTaskId;
        const before = dropBefore(e.clientY);
        onDragStateChange(null, null);
        if (!taskId || before?.id === taskId) return;
        onMoveTask(
          taskId,
          column.id,
          positionBefore(
            tasks.filter((t) => t.id !== taskId),
            before,
          ),
        );
      }}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium"
          title={
            {
              queued: "",
              none: "",
              active:
                "Unlinked cards here are picked up by the agent; linked cards are in progress",
              review: "Cards land here when the agent finishes a turn",
              done: "Cards land here when their PR merges",
            }[column.role]
          }
        >
          {column.name}
        </span>
        <Badge
          variant="secondary"
          className="h-5 min-w-5 justify-center px-1 text-[11px]"
        >
          {tasks.length}
        </Badge>
      </div>

      <div
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2"
      >
        {tasks.map((task) => (
          <div key={task.id} className="flex shrink-0 flex-col gap-2">
            {dropSpot?.before === task.id && <DropLine />}
            <TaskCard
              task={task}
              columnRole={column.role}
              ctx={ctx}
              projectName={
                task.projectId ? projectNames.get(task.projectId) : undefined
              }
              workspace={
                task.workspaceId ? workspaces.get(task.workspaceId) : undefined
              }
              session={
                task.workspaceId ? sessions[task.workspaceId] : undefined
              }
              pr={task.workspaceId ? prs[task.workspaceId] : undefined}
              diffStat={
                task.workspaceId ? diffStats[task.workspaceId] : undefined
              }
              dragging={dragTaskId === task.id}
              focused={focusedId === task.id}
              onDragStateChange={onDragStateChange}
              onFocus={onFocus}
              onEdit={onEdit}
              onDrill={onDrill}
              onStartTask={onStartTask}
              onOpenSession={onOpenSession}
              onOpenArchive={onOpenArchive}
            />
          </div>
        ))}
        {dropSpot && dropSpot.before === null && <DropLine />}

        {onQuickAdd ? (
          // Drill-down: an inline input that keeps focus for rapid entry.
          <QuickAddInput onAdd={onQuickAdd} />
        ) : (
          /* Hover affordance: appears under the last card, outlines on its own
             hover, and opens the create dialog (title pre-focused). */
          <button
            onClick={onAdd}
            className="mx-auto mt-1 flex items-center gap-1 rounded-md border border-transparent px-3 py-1.5 text-xs text-muted-foreground opacity-0 transition-all hover:border-border hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/column:opacity-100"
          >
            <Plus className="size-3.5" />
            Add task
          </button>
        )}
      </div>
    </div>
  );
}

/** Drill-down per-column quick add: Enter creates and keeps focus. */
function QuickAddInput({ onAdd }: { onAdd: (title: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        const title = value.trim();
        if (!title) return;
        onAdd(title);
        setValue("");
      }}
      placeholder="Add a subtask…"
      className="mt-1 h-7 shrink-0 rounded-md border border-transparent bg-transparent px-2 text-xs outline-none transition-colors placeholder:text-muted-foreground hover:border-border focus:border-border"
    />
  );
}

/** The header-right live-status chip. Clicking it opens the linked session
 *  when one exists (the old session-chip behavior). */
function StatusChip({
  state,
  workspace,
  session,
  pr,
  onOpenSession,
}: {
  state: CardState;
  workspace?: Workspace;
  session?: SessionPayload;
  pr?: PrPayload;
  onOpenSession: (workspaceId: string) => void;
}) {
  const chip = ((): {
    label: string;
    icon?: React.ReactNode;
    className: string;
    title?: string;
  } | null => {
    if (workspace?.setup === "provisioning")
      return {
        label: "setting up",
        icon: <Loader2 className="size-2.5 animate-spin" />,
        className: "border-border text-muted-foreground",
      };
    if (workspace?.setup === "failed")
      return {
        label: "setup failed",
        className: "border-destructive/40 text-destructive",
      };
    if (session?.awaitingInput || session?.needsAttention)
      return {
        label: "needs you",
        className: "border-warning/45 bg-warning/10 text-warning",
      };
    if (state === "done")
      return pr?.status?.state === "MERGED"
        ? {
            label: "merged",
            icon: <GitPullRequest className="size-2.5" />,
            className: cn("border-transparent", REVIEW_TEXT),
          }
        : null;
    if (state === "review")
      return { label: "review", className: cn(REVIEW_BORDER, REVIEW_TEXT) };
    if (state === "working")
      return {
        label: "working…",
        icon: <Loader2 className="size-2.5 animate-spin" />,
        className: "border-primary/40 text-primary",
      };
    if (state === "queued")
      return {
        label: "queued",
        icon: <Clock className="size-2.5" />,
        className: "border-border text-muted-foreground",
        title: "Waiting for an agent slot — picked up automatically",
      };
    return null;
  })();
  if (!chip) return null;

  const inner = (
    <>
      {chip.icon}
      {chip.label}
    </>
  );
  return workspace ? (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onOpenSession(workspace.id);
      }}
      className={cn(CHIP, "shrink-0 hover:bg-accent", chip.className)}
      title="Open the linked session"
    >
      {inner}
    </button>
  ) : (
    <span className={cn(CHIP, "shrink-0", chip.className)} title={chip.title}>
      {inner}
    </span>
  );
}

/** Footer PR chip: number + a checks glyph colored by the CI rollup. */
function PrChip({ status }: { status: PrStatus }) {
  const marks: Record<string, string> = {
    success: "✓",
    failure: "✗",
    pending: "…",
  };
  const mark = marks[status.rollup];
  return (
    <span
      className={cn(
        CHIP,
        status.rollup === "success"
          ? "border-additions/40 text-additions"
          : status.rollup === "failure"
            ? "border-destructive/40 text-destructive"
            : "border-border text-muted-foreground",
      )}
      title={`PR #${status.number} — checks ${status.rollup}`}
    >
      <GitPullRequest className="size-2.5" />
      PR #{status.number}
      {mark && ` · ${mark}`}
    </span>
  );
}

/** Dashed "after #N" chip: the first dependency not yet in Done. */
function DepChip({ number }: { number: number }) {
  return (
    <span
      className={cn(CHIP, "border-dashed border-border text-muted-foreground")}
      title="Dispatch waits until this dependency reaches Done"
    >
      <Lock className="size-2.5" />
      after <span className="font-mono">#{number}</span>
    </span>
  );
}

// Segmented subtask bar: sort + color order, done → todo, so it reads like
// a progress bar even though every child keeps its own segment.
const SEG_ORDER: Record<CardState, number> = {
  done: 0,
  review: 1,
  working: 2,
  queued: 3,
  todo: 3,
};
const SEG_COLOR: Record<CardState, string> = {
  done: "bg-additions",
  review: "bg-[#a371f7]", // GitHub's review purple (no theme token)
  working: "bg-warning",
  queued: "bg-accent",
  todo: "bg-accent",
};

/** A parent card's full-width subtask bar: one status-colored segment per
 *  child + a done count. Clicking it drills into the children's board. */
function SubtaskBar({
  subtasks,
  ctx,
  doneCount,
  onDrill,
}: {
  subtasks: Task[];
  ctx: BoardCtx;
  doneCount: number;
  onDrill: () => void;
}) {
  const states = subtasks
    .map((c) => deriveState(c, ctx.roleById.get(c.columnId) ?? "none"))
    .sort((a, b) => SEG_ORDER[a] - SEG_ORDER[b]);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onDrill();
      }}
      aria-label="Open subtasks"
      title="Open subtasks"
      className="group/subtasks mt-2 flex w-full cursor-pointer items-center gap-1.5"
    >
      <span className="flex h-1 min-w-0 flex-1 gap-px overflow-hidden rounded-full transition-[filter] group-hover/subtasks:brightness-125">
        {states.map((s, i) => (
          <span key={i} className={cn("h-full flex-1", SEG_COLOR[s])} />
        ))}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground group-hover/subtasks:underline">
        {doneCount}/{subtasks.length}
      </span>
    </button>
  );
}

function TaskCard({
  task,
  columnRole,
  ctx,
  projectName,
  workspace,
  session,
  pr,
  diffStat,
  dragging,
  focused,
  onDragStateChange,
  onFocus,
  onEdit,
  onDrill,
  onStartTask,
  onOpenSession,
  onOpenArchive,
}: {
  task: Task;
  columnRole: ColumnRole;
  ctx: BoardCtx;
  projectName?: string;
  workspace?: Workspace;
  session?: SessionPayload;
  pr?: PrPayload;
  diffStat?: DiffStat;
  dragging: boolean;
  focused: boolean;
  onDragStateChange: (taskId?: string | null, spot?: DropSpot | null) => void;
  onFocus: (id: string) => void;
  onEdit: (t: Task) => void;
  onDrill: (id: string) => void;
  onStartTask: (t: Task) => void;
  onOpenSession: (workspaceId: string) => void;
  onOpenArchive: (t: Task) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  const children = ctx.childrenByParent.get(task.id) ?? [];
  const isParent = children.length > 0;
  const state = deriveState(task, columnRole);
  const needsYou =
    !isParent && !!(session?.awaitingInput || session?.needsAttention);
  const unmetDep = firstUnmetDep(task, ctx);
  const doneKids = children.filter(
    (c) => ctx.roleById.get(c.columnId) === "done",
  ).length;

  const showPr =
    !isParent && workspace && pr?.status && pr.status.state === "OPEN"
      ? pr.status
      : null;
  const showDiff =
    !isParent && !!workspace && (diffStat?.files ?? 0) > 0 && state !== "done";
  /** Linked chat whose workspace is gone — the transcript lives on. */
  const isArchived = !isParent && !!task.workspaceId && !workspace;
  const hasFooter = showPr !== null || showDiff || unmetDep !== null;

  const card = (
    <div
      ref={ref}
      data-task-id={task.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStateChange(task.id, undefined);
      }}
      onDragEnd={() => onDragStateChange(null, null)}
      onClick={() => {
        onFocus(task.id);
        // Every card opens its dialog; the subtask bar drills into parents.
        onEdit(task);
      }}
      className={cn(
        "group/card cursor-pointer rounded-md border bg-card px-3 py-2.5 shadow-sm transition-opacity hover:bg-accent/40",
        focused
          ? "border-primary/60 ring-1 ring-primary/40"
          : needsYou
            ? "border-warning/45 hover:border-warning/60"
            : "border-border hover:border-border/80",
        dragging && "opacity-40",
      )}
    >
      {/* Header: state glyph + muted "project #N" ref; the top-right slot is
          always the live session chip's home (empty for parents, which have
          no session of their own). */}
      <div className="flex items-center gap-1.5">
        <StateIcon state={state} />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
          {projectName && <>{projectName} </>}
          <span className="font-mono">#{task.number}</span>
        </span>
        {isArchived ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenArchive(task);
            }}
            className={cn(
              CHIP,
              "shrink-0 border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            title="The workspace is gone; open the archived conversation"
          >
            <MessageSquare className="size-2.5" />
            history
          </button>
        ) : (
          !isParent && (
            <StatusChip
              state={state}
              workspace={workspace}
              session={session}
              pr={pr}
              onOpenSession={onOpenSession}
            />
          )
        )}
      </div>

      <div className="mt-1 text-sm font-medium leading-snug">{task.title}</div>

      {isParent && (
        <SubtaskBar
          subtasks={children}
          ctx={ctx}
          doneCount={doneKids}
          onDrill={() => onDrill(task.id)}
        />
      )}

      {hasFooter && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {showPr && <PrChip status={showPr} />}
          {showDiff && diffStat && (
            <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
              <span className="text-additions">+{diffStat.insertions}</span>
              <span className="text-deletions">−{diffStat.deletions}</span>
            </span>
          )}
          {unmetDep && <DepChip number={unmetDep.number} />}
        </div>
      )}
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent>
        {!workspace && !isParent && (
          <ContextMenuItem onClick={() => onStartTask(task)}>
            <Play className="mr-2 size-3.5" />
            {task.workspaceId ? "Start new session" : "Start session"}
          </ContextMenuItem>
        )}
        {workspace && (
          <ContextMenuItem onClick={() => onOpenSession(workspace.id)}>
            <MessageSquare className="mr-2 size-3.5" />
            Open session
          </ContextMenuItem>
        )}
        {task.workspaceId && !workspace && (
          <ContextMenuItem onClick={() => onOpenArchive(task)}>
            <MessageSquare className="mr-2 size-3.5" />
            Open archived chat
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => onEdit(task)}>
          <CircleDot className="mr-2 size-3.5" />
          Edit…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={() =>
            taskDelete(task.id).catch((e) =>
              toast.error("Could not delete task", { description: String(e) }),
            )
          }
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Which picker popover is open (create-dialog chips + edit-dialog rail). */
type PickerId =
  | "status"
  | "project"
  | "estimate"
  | "blockedBy"
  | "blocks"
  | "import";

/** Linear-style create dialog: borderless title/description, a chip per
 *  property (each with a key), ⌘↵ to submit, "Create more" to keep going.
 *  Editing an existing task opens TaskEditDialog instead. */
function TaskCreateDialog({
  state,
  projects,
  ctx,
  columns,
  boardUnit,
  onClose,
}: {
  state: Extract<DialogState, { mode: "create" }>;
  projects: ProjectView[];
  ctx: BoardCtx;
  columns: BoardColumn[];
  boardUnit: EstimateUnit;
  onClose: () => void;
}) {
  const isSubtask = !!state.parentId;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [columnId, setColumnId] = useState(state.columnId);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [editingEstimate, setEditingEstimate] = useState(false);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [createMore, setCreateMore] = useState(false);
  const [picker, setPicker] = useState<PickerId | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // GitHub import: a searchable dropdown of the repo's open issues
  // (already sorted newest-updated first by the backend).
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [loadingIssues, setLoadingIssues] = useState(false);
  /** GitHub Projects estimate carried from the imported issue, if any. */
  const [importEstimate, setImportEstimate] = useState<number | null>(null);

  const openIssuePicker = () => {
    if (!projectId) return;
    setPicker("import");
    if (issues === null) {
      setLoadingIssues(true);
      listProjectIssues(projectId)
        .then(setIssues)
        .catch((e) => {
          setPicker(null);
          toast.error("Could not load GitHub issues", {
            description: String(e),
          });
        })
        .finally(() => setLoadingIssues(false));
    }
  };

  const applyIssue = (issue: IssueSummary) => {
    setTitle(issue.title);
    setDescription(
      [
        `GitHub issue [#${issue.number}](${issue.url}) by ${issue.author}`,
        "",
        issue.body ?? "",
      ]
        .join("\n")
        .trim(),
    );
    setImportEstimate(issue.estimate);
    setPicker(null);
  };

  // Effective project (subtasks inherit the parent's) drives the estimate
  // unit and the breadcrumb/chip label.
  const parent = state.parentId ? ctx.taskById.get(state.parentId) : undefined;
  const effProjectId = isSubtask ? (parent?.projectId ?? "") : projectId;
  const projectName = effProjectId
    ? projects.find((p) => p.id === effProjectId)?.name
    : null;
  const unit =
    projects.find((p) => p.id === effProjectId)?.estimate_unit ?? boardUnit;
  /** Explicit estimate wins over one carried from an imported issue. */
  const effEstimate = estimate ?? importEstimate;

  const column = columns.find((c) => c.id === columnId) ?? columns[0];
  // Blocked-by candidates: siblings for a subtask, top-level tasks otherwise
  // (matching the peers rule used when editing), excluding done cards.
  const candidates = [...ctx.taskById.values()]
    .filter(
      (t) =>
        t.parentId === (state.parentId ?? null) &&
        ctx.roleById.get(t.columnId) !== "done",
    )
    .sort(byNumber);
  const selectedDeps = new Set(dependsOn);

  const save = () => {
    if (!title.trim()) return;
    taskCreate(title.trim(), {
      description: description || undefined,
      // Subtasks inherit the parent's project server-side.
      projectId: isSubtask ? undefined : projectId || undefined,
      columnId,
      parentId: state.parentId ?? undefined,
    })
      .then((created) => {
        // taskCreate has no estimate/dependsOn args — they land via a
        // follow-up patch (as the imported-issue estimate always has).
        const patch: { estimate?: number; dependsOn?: string[] } = {};
        if (effEstimate !== null) patch.estimate = effEstimate;
        if (dependsOn.length) patch.dependsOn = dependsOn;
        return Object.keys(patch).length
          ? taskUpdate(created.id, patch)
          : undefined;
      })
      .then(() => {
        if (!createMore) {
          onClose();
          return;
        }
        // Keep project + column for rapid entry; reset the rest.
        setTitle("");
        setDescription("");
        setEstimate(null);
        setImportEstimate(null);
        setDependsOn([]);
        titleRef.current?.focus();
      })
      .catch((e) =>
        toast.error("Could not save task", { description: String(e) }),
      );
  };

  // ⌘↵ submits from anywhere; the chip keys only fire outside text fields.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable=true]")) return;
    const open = (id: PickerId) => {
      e.preventDefault();
      setPicker(id);
    };
    switch (e.key) {
      case "s":
      case "S":
        open("status");
        break;
      case "p":
      case "P":
        if (!isSubtask) open("project");
        break;
      case "e":
      case "E":
        // Points/hours edit inline in the chip row; only t-shirt pops a list.
        if (unit === "tshirt") open("estimate");
        else {
          e.preventDefault();
          setEditingEstimate(true);
        }
        break;
      case "b":
      case "B":
        open("blockedBy");
        break;
      case "i":
      case "I":
        if (!isSubtask && projectId) {
          e.preventDefault();
          openIssuePicker();
        }
        break;
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        onKeyDown={onKeyDown}
        className="flex w-[min(44rem,92vw)] flex-col gap-1 sm:max-w-none"
      >
        <DialogTitle className="sr-only">
          {isSubtask ? "New subtask" : "New task"}
        </DialogTitle>
        {/* Breadcrumb: project chip (reflects the selection) › New task */}
        <div className="mb-2 flex items-center gap-2 pr-8 text-[11.5px] text-muted-foreground">
          <span className="flex max-w-56 items-center rounded-md border border-border bg-accent/50 px-2 py-0.5">
            <span className="truncate">{projectName ?? "No project"}</span>
          </span>
          <span className="text-border">›</span>
          <span>
            {isSubtask ? `New subtask of #${parent?.number}` : "New task"}
          </span>
        </div>

        <input
          ref={titleRef}
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              save();
            }
          }}
          placeholder="Task title"
          className="w-full bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground/60"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add a description… (markdown)"
          className="min-h-16 w-full resize-none bg-transparent pb-4 text-sm outline-none placeholder:text-muted-foreground/60"
        />

        {/* Property chips — click or key opens the same command pickers the
            edit dialog's rail uses. */}
        <div className="flex flex-wrap items-center gap-1.5 pb-3">
          <Popover
            open={picker === "status"}
            onOpenChange={(o) => setPicker(o ? "status" : null)}
          >
            <PopoverTrigger asChild>
              <CreateChip
                set
                kbd="S"
                icon={<StateIcon state={roleToState(column?.role ?? "none")} />}
              >
                {column?.name ?? "Column"}
              </CreateChip>
            </PopoverTrigger>
            <PickerContent align="start" className="w-56">
              <ColumnPicker
                columns={columns}
                onSelect={(c) => {
                  setColumnId(c.id);
                  setPicker(null);
                }}
              />
            </PickerContent>
          </Popover>

          {!isSubtask && (
            <Popover
              open={picker === "project"}
              onOpenChange={(o) => setPicker(o ? "project" : null)}
            >
              <PopoverTrigger asChild>
                <CreateChip
                  set={!!projectId}
                  kbd="P"
                  icon={<PanelTop className="size-3" />}
                >
                  {projectName ?? "No project"}
                </CreateChip>
              </PopoverTrigger>
              <PickerContent align="start" className="w-72">
                <ProjectPicker
                  projects={projects}
                  onSelect={(id) => {
                    setProjectId(id);
                    // The issue cache belongs to the previous project.
                    setIssues(null);
                    setImportEstimate(null);
                    setPicker(null);
                  }}
                />
              </PickerContent>
            </Popover>
          )}

          {unit === "tshirt" ? (
            <Popover
              open={picker === "estimate"}
              onOpenChange={(o) => setPicker(o ? "estimate" : null)}
            >
              <PopoverTrigger asChild>
                <CreateChip
                  set={effEstimate !== null}
                  kbd="E"
                  icon={<Triangle className="size-3" />}
                >
                  {effEstimate !== null
                    ? estimateLabel(effEstimate, unit)
                    : "Estimate"}
                </CreateChip>
              </PopoverTrigger>
              <PickerContent align="start" className="w-56">
                <EstimatePicker
                  onSelect={(v) => {
                    setEstimate(v < 0 ? null : v);
                    if (v < 0) setImportEstimate(null);
                    setPicker(null);
                  }}
                />
              </PickerContent>
            </Popover>
          ) : editingEstimate ? (
            // Points/hours: the chip swaps to a tiny inline number input.
            <span className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11.5px]">
              <Triangle className="size-3 shrink-0 text-muted-foreground" />
              <InlineEstimateInput
                initial={effEstimate === null ? "" : String(effEstimate)}
                unit={unit}
                onCommit={(v) => {
                  setEditingEstimate(false);
                  setEstimate(v);
                  if (v === null) setImportEstimate(null);
                }}
                onCancel={() => setEditingEstimate(false)}
                className="w-16 bg-transparent outline-none placeholder:text-muted-foreground"
              />
            </span>
          ) : (
            <CreateChip
              set={effEstimate !== null}
              kbd="E"
              icon={<Triangle className="size-3" />}
              onClick={() => setEditingEstimate(true)}
            >
              {effEstimate !== null
                ? estimateLabel(effEstimate, unit)
                : "Estimate"}
            </CreateChip>
          )}

          <Popover
            open={picker === "blockedBy"}
            onOpenChange={(o) => setPicker(o ? "blockedBy" : null)}
          >
            <PopoverTrigger asChild>
              <CreateChip
                set={dependsOn.length > 0}
                kbd="B"
                icon={<Lock className="size-3" />}
              >
                {dependsOn.length
                  ? `Blocked by ${dependsOn
                      .map((id) => `#${ctx.taskById.get(id)?.number}`)
                      .join(" ")}`
                  : "Blocked by"}
              </CreateChip>
            </PopoverTrigger>
            <PickerContent align="start" className="w-72">
              <DepPickerContent
                candidates={candidates}
                selected={selectedDeps}
                onSelect={(t) =>
                  // Toggle; the popover stays open for multi-select.
                  setDependsOn((prev) =>
                    prev.includes(t.id)
                      ? prev.filter((id) => id !== t.id)
                      : [...prev, t.id],
                  )
                }
              />
            </PickerContent>
          </Popover>

          {!isSubtask && (
            <Popover
              open={picker === "import"}
              onOpenChange={(o) => (o ? openIssuePicker() : setPicker(null))}
            >
              <PopoverTrigger asChild>
                <CreateChip
                  kbd="I"
                  icon={<CloudDownload className="size-3" />}
                  disabled={!projectId}
                  title={
                    projectId
                      ? "Fill this task from an open GitHub issue"
                      : "Select a project first"
                  }
                >
                  Import issue
                </CreateChip>
              </PopoverTrigger>
              <PickerContent align="start" className="w-[28rem]">
                <Command>
                  <CommandInput placeholder="Search open issues…" />
                  <CommandSeparator className="mt-1" />
                  <CommandList className="max-h-72 p-1">
                    {loadingIssues ? (
                      <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        Loading issues…
                      </div>
                    ) : (
                      <>
                        <CommandEmpty>No matching issues.</CommandEmpty>
                        {(issues ?? []).map((issue) => (
                          <CommandItem
                            key={issue.number}
                            value={`#${issue.number} ${issue.title} ${issue.author}`}
                            onSelect={() => applyIssue(issue)}
                            className="gap-2"
                          >
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                              #{issue.number}
                            </span>
                            <span className="min-w-0 flex-1 truncate">
                              {issue.title}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {issue.author}
                            </span>
                          </CommandItem>
                        ))}
                      </>
                    )}
                  </CommandList>
                </Command>
              </PickerContent>
            </Popover>
          )}
        </div>

        <div className="-mx-4 flex items-center justify-end gap-4 border-t border-border px-4 pt-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={createMore} onCheckedChange={setCreateMore} />
            Create more
          </label>
          <Button size="sm" onClick={save} disabled={!title.trim()}>
            Create task
            <span className="ml-1 font-mono text-[10px] opacity-70">⌘↵</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Edit dialog → the task view: a main column (title, markdown description,
 *  subtasks, activity feed + comment composer) and a Linear-style properties
 *  rail where every row has a key. Every field commits independently. */
function TaskEditDialog({
  task,
  ctx,
  boardUnit,
  projects,
  columns,
  workspaces,
  sessions,
  prs,
  diffStats,
  onOpenSession,
  onStartTask,
  onSwitchTask,
  onShowShortcuts,
  onClose,
}: {
  task: Task;
  ctx: BoardCtx;
  /** Board-global estimate unit (the task's project can override it). */
  boardUnit: EstimateUnit;
  projects: ProjectView[];
  columns: BoardColumn[];
  workspaces: Map<string, Workspace>;
  sessions: Record<string, SessionPayload>;
  prs: Record<string, PrPayload>;
  diffStats: Record<string, DiffStat>;
  onOpenSession: (workspaceId: string) => void;
  onStartTask: (t: Task) => void;
  /** Re-target the dialog to another task (parent row / subtask rows). */
  onSwitchTask: (t: Task) => void;
  onShowShortcuts: () => void;
  onClose: () => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [editingEstimate, setEditingEstimate] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [picker, setPicker] = useState<PickerId | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<{ focusSlash: () => void } | null>(null);

  const fail = (e: unknown) =>
    toast.error("Could not save task", { description: String(e) });

  const commitTitle = () => {
    setEditingTitle(false);
    const next = titleDraft.trim();
    if (!next || next === task.title) return;
    taskUpdate(task.id, { title: next }).catch(fail);
  };
  const startTitleEdit = () => {
    setTitleDraft(task.title);
    setEditingTitle(true);
  };
  const commitDesc = () => {
    setEditingDesc(false);
    if (descDraft === (task.description ?? "")) return;
    taskUpdate(task.id, { description: descDraft }).catch(fail);
  };
  const startDescEdit = () => {
    setDescDraft(task.description ?? "");
    setEditingDesc(true);
  };
  // Effective estimate unit: the project's override, else the board global.
  // Subtasks inherit the parent's project, so this holds for them too.
  const unit =
    projects.find((p) => p.id === task.projectId)?.estimate_unit ?? boardUnit;

  const isParent = (ctx.childrenByParent.get(task.id)?.length ?? 0) > 0;
  const parentTask = task.parentId
    ? (ctx.taskById.get(task.parentId) ?? null)
    : null;
  const role = ctx.roleById.get(task.columnId) ?? "none";
  const state = deriveState(task, role);
  const column = columns.find((c) => c.id === task.columnId);
  const project = projects.find((p) => p.id === task.projectId);
  const workspace = task.workspaceId
    ? workspaces.get(task.workspaceId)
    : undefined;
  const session = task.workspaceId ? sessions[task.workspaceId] : undefined;
  const pr = task.workspaceId ? prs[task.workspaceId] : undefined;
  const diffStat = task.workspaceId ? diffStats[task.workspaceId] : undefined;

  const peers = depCandidates(task, ctx);
  const blockedBy = task.dependsOn
    .map((id) => ctx.taskById.get(id))
    .filter((t): t is Task => t !== undefined);
  const blocks = [...ctx.taskById.values()]
    .filter((t) => t.dependsOn.includes(task.id))
    .sort(byNumber);

  /** Status change = move to the end of the chosen column. */
  const setStatus = (columnId: string) => {
    setPicker(null);
    if (columnId === task.columnId) return;
    const end =
      Math.max(
        0,
        ...[...ctx.taskById.values()]
          .filter((t) => t.columnId === columnId)
          .map((t) => t.position),
      ) + 1024;
    taskMove(task.id, columnId, end).catch((e) =>
      toast.error("Could not move task", { description: String(e) }),
    );
  };

  const openOrStartSession = () => {
    if (workspace) onOpenSession(workspace.id);
    else if (!isParent) {
      onClose();
      onStartTask(task);
    }
  };

  // Single-key shortcuts, Linear-style: only when no text field has focus.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable=true]")) return;
    const open = (id: PickerId) => {
      e.preventDefault();
      setPicker(id);
    };
    switch (e.key) {
      case "s":
        open("status");
        break;
      case "p":
        open("project");
        break;
      case "e":
        // Points/hours edit inline in place; only t-shirt has a picker.
        if (unit === "tshirt") open("estimate");
        else {
          e.preventDefault();
          setEditingEstimate(true);
        }
        break;
      case "b":
        open("blockedBy");
        break;
      case "B":
        open("blocks");
        break;
      case "/":
        e.preventDefault();
        composerRef.current?.focusSlash();
        break;
      case "a":
        if (task.parentId === null) {
          e.preventDefault();
          addInputRef.current?.focus();
        }
        break;
      case "o":
        e.preventDefault();
        openOrStartSession();
        break;
      case "?":
        e.preventDefault();
        onShowShortcuts();
        break;
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        onKeyDown={onKeyDown}
        className="flex h-[85vh] w-[min(64rem,94vw)] flex-row gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        {/* ── Main column ── */}
        <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
          {/* Eyebrow: project chip › task ref, with the dialog's close X. */}
          <div className="flex shrink-0 items-center gap-2 text-[11.5px] text-muted-foreground">
            <span className="flex max-w-48 items-center rounded-md border border-border bg-accent/50 px-2 py-0.5">
              <span className="truncate">{project?.name ?? "No project"}</span>
            </span>
            <span className="text-border">›</span>
            <span className="font-mono">Task #{task.number}</span>
            <div className="flex-1" />
            <span className="text-[10.5px] text-muted-foreground/60">
              esc to close
            </span>
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
              >
                <X className="size-3.5" />
                <span className="sr-only">Close</span>
              </Button>
            </DialogClose>
          </div>

          {/* Title (click to rename) */}
          {editingTitle ? (
            <>
              <DialogTitle className="sr-only">Task #{task.number}</DialogTitle>
              <Input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTitle();
                  if (e.key === "Escape") {
                    // Cancel the rename without closing the dialog.
                    e.preventDefault();
                    e.stopPropagation();
                    setEditingTitle(false);
                  }
                }}
                className="h-auto rounded-none border-transparent bg-transparent px-0 py-0.5 text-xl font-semibold shadow-none focus-visible:ring-0 md:text-xl dark:bg-transparent"
              />
            </>
          ) : (
            <DialogTitle
              className="cursor-text py-0.5 text-xl"
              onClick={startTitleEdit}
              title="Click to rename"
            >
              {task.title}
            </DialogTitle>
          )}

          {/* Description (hover pencil / double-click to edit) */}
          <div className="group/desc flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Description
              </span>
              {!editingDesc && (
                <button
                  onClick={startDescEdit}
                  title="Edit description"
                  className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/desc:opacity-100"
                >
                  <Pencil className="size-3" />
                </button>
              )}
            </div>
            {editingDesc ? (
              <div className="flex flex-col gap-2">
                <MarkdownEditor
                  value={descDraft}
                  onChange={setDescDraft}
                  placeholder="Optional — markdown, included in the session prompt."
                  className="min-h-48"
                />
                <div className="flex justify-end">
                  <Button variant="ghost" size="sm" onClick={commitDesc}>
                    Done
                  </Button>
                </div>
              </div>
            ) : task.description?.trim() ? (
              <div
                className="markdown-content cursor-text text-sm"
                onDoubleClick={startDescEdit}
                title="Double-click to edit"
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {task.description}
                </ReactMarkdown>
              </div>
            ) : (
              <button
                onClick={startDescEdit}
                className="self-start text-sm text-muted-foreground hover:text-foreground"
              >
                No description — click to add
              </button>
            )}
          </div>

          {task.parentId === null && (
            <SubtasksSection
              task={task}
              ctx={ctx}
              unit={unit}
              workspaces={workspaces}
              sessions={sessions}
              prs={prs}
              onOpenSession={onOpenSession}
              onOpen={onSwitchTask}
              addInputRef={addInputRef}
            />
          )}

          <ActivityFeed task={task} composerRef={composerRef} />
        </div>

        {/* ── Properties rail ── */}
        <div className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-muted/20 px-3.5 py-5">
          <div className="flex flex-col gap-0.5">
            <span className="mb-1.5 px-1.5 text-[10.5px] font-semibold tracking-wide text-muted-foreground">
              PROPERTIES
            </span>

            {parentTask && (
              <RailRow
                icon={
                  <StateIcon
                    state={deriveState(
                      parentTask,
                      ctx.roleById.get(parentTask.columnId) ?? "none",
                    )}
                  />
                }
                onClick={() => onSwitchTask(parentTask)}
                title={`Parent — #${parentTask.number} ${parentTask.title}`}
              >
                <span className="font-mono text-muted-foreground">
                  #{parentTask.number}
                </span>{" "}
                {parentTask.title}
              </RailRow>
            )}

            <Popover
              open={picker === "status"}
              onOpenChange={(o) => setPicker(o ? "status" : null)}
            >
              <PopoverTrigger asChild>
                <RailRow icon={<StateIcon state={state} />} kbd="S">
                  {column?.name ?? "—"}
                </RailRow>
              </PopoverTrigger>
              <PickerContent align="end" className="w-56">
                <ColumnPicker columns={columns} onSelect={(c) => setStatus(c.id)} />
              </PickerContent>
            </Popover>

            <Popover
              open={picker === "project"}
              onOpenChange={(o) => setPicker(o ? "project" : null)}
            >
              <PopoverTrigger asChild>
                <RailRow
                  icon={<PanelTop className="size-[13px]" />}
                  kbd="P"
                  muted={!task.projectId}
                >
                  {project?.name ?? "No project"}
                </RailRow>
              </PopoverTrigger>
              <PickerContent align="end" className="w-72">
                <ProjectPicker
                  projects={projects}
                  onSelect={(id) => {
                    setPicker(null);
                    taskUpdate(task.id, { projectId: id }).catch(fail);
                  }}
                />
              </PickerContent>
            </Popover>

            {unit === "tshirt" ? (
              <Popover
                open={picker === "estimate"}
                onOpenChange={(o) => setPicker(o ? "estimate" : null)}
              >
                <PopoverTrigger asChild>
                  <RailRow
                    icon={<Triangle className="size-[13px]" />}
                    kbd="E"
                    muted={task.estimate === null}
                  >
                    {task.estimate !== null
                      ? estimateLabel(task.estimate, unit)
                      : "Estimate —"}
                  </RailRow>
                </PopoverTrigger>
                <PickerContent align="end" className="w-56">
                  <EstimatePicker
                    onSelect={(v) => {
                      setPicker(null);
                      taskUpdate(task.id, { estimate: v }).catch(fail);
                    }}
                  />
                </PickerContent>
              </Popover>
            ) : editingEstimate ? (
              // Points/hours: the value swaps to an inline number input.
              <div className="flex w-full items-center gap-2 px-1.5 py-1">
                <span className="flex size-[13px] shrink-0 items-center justify-center text-muted-foreground">
                  <Triangle className="size-[13px]" />
                </span>
                <InlineEstimateInput
                  initial={task.estimate === null ? "" : String(task.estimate)}
                  unit={unit}
                  onCommit={(v) => {
                    setEditingEstimate(false);
                    if (v === task.estimate) return;
                    // null clears (-1 is the backend's unset sentinel).
                    taskUpdate(task.id, { estimate: v ?? -1 }).catch(fail);
                  }}
                  onCancel={() => setEditingEstimate(false)}
                  className="h-5 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                />
              </div>
            ) : (
              <RailRow
                icon={<Triangle className="size-[13px]" />}
                kbd="E"
                muted={task.estimate === null}
                onClick={() => setEditingEstimate(true)}
              >
                {task.estimate !== null
                  ? estimateLabel(task.estimate, unit)
                  : "Estimate —"}
              </RailRow>
            )}

            <div className="flex flex-col gap-1">
              <Popover
                open={picker === "blockedBy"}
                onOpenChange={(o) => setPicker(o ? "blockedBy" : null)}
              >
                <PopoverTrigger asChild>
                  <RailRow
                    icon={<Lock className="size-[13px]" />}
                    kbd="B"
                    muted={blockedBy.length === 0}
                  >
                    Blocked by{blockedBy.length === 0 && " —"}
                  </RailRow>
                </PopoverTrigger>
                <PickerContent align="end" className="w-72">
                  <DepPickerContent
                    candidates={peers.filter(
                      (t) => !task.dependsOn.includes(t.id),
                    )}
                    onSelect={(dep) => {
                      setPicker(null);
                      taskUpdate(task.id, {
                        dependsOn: [...task.dependsOn, dep.id],
                      }).catch(fail);
                    }}
                  />
                </PickerContent>
              </Popover>
              {blockedBy.length > 0 && (
                <div className="flex flex-wrap gap-1 pb-1 pl-7">
                  {blockedBy.map((dep) => (
                    <DepEditChip
                      key={dep.id}
                      task={dep}
                      onRemove={() =>
                        taskUpdate(task.id, {
                          dependsOn: task.dependsOn.filter(
                            (id) => id !== dep.id,
                          ),
                        }).catch(fail)
                      }
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <Popover
                open={picker === "blocks"}
                onOpenChange={(o) => setPicker(o ? "blocks" : null)}
              >
                <PopoverTrigger asChild>
                  <RailRow
                    icon={<Lock className="size-[13px] rotate-180" />}
                    kbd="⇧B"
                    muted={blocks.length === 0}
                  >
                    Blocks{blocks.length === 0 && " —"}
                  </RailRow>
                </PopoverTrigger>
                <PickerContent align="end" className="w-72">
                  <DepPickerContent
                    candidates={peers.filter(
                      (t) => !t.dependsOn.includes(task.id),
                    )}
                    onSelect={(other) => {
                      setPicker(null);
                      taskUpdate(other.id, {
                        dependsOn: [...other.dependsOn, task.id],
                      }).catch(fail);
                    }}
                  />
                </PickerContent>
              </Popover>
              {blocks.length > 0 && (
                <div className="flex flex-wrap gap-1 pb-1 pl-7">
                  {blocks.map((other) => (
                    <DepEditChip
                      key={other.id}
                      task={other}
                      onRemove={() =>
                        taskUpdate(other.id, {
                          dependsOn: other.dependsOn.filter(
                            (id) => id !== task.id,
                          ),
                        }).catch(fail)
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {(workspace || !isParent) && (
            <>
              <div className="h-px shrink-0 bg-border" />
              <div className="flex flex-col gap-1.5">
                <span className="mb-0.5 px-1.5 text-[10.5px] font-semibold tracking-wide text-muted-foreground">
                  SESSION
                </span>
                {workspace ? (
                  <>
                    <div className="px-1.5">
                      <StatusChip
                        state={state}
                        workspace={workspace}
                        session={session}
                        pr={pr}
                        onOpenSession={onOpenSession}
                      />
                    </div>
                    <RailRow
                      icon={<MessageSquare className="size-[13px]" />}
                      kbd="O"
                      onClick={() => onOpenSession(workspace.id)}
                    >
                      Open session
                    </RailRow>
                    {diffStat && diffStat.files > 0 && (
                      <div className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
                        <span className="text-additions">
                          +{diffStat.insertions}
                        </span>
                        <span className="text-deletions">
                          −{diffStat.deletions}
                        </span>
                        uncommitted
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <RailRow
                      icon={<Play className="size-[13px]" />}
                      kbd="O"
                      onClick={openOrStartSession}
                    >
                      {task.workspaceId ? "Start new session" : "Start session"}
                    </RailRow>
                    {task.workspaceId && (
                      // Workspace gone but the transcript survives in chat.db.
                      <RailRow
                        icon={<MessageSquare className="size-[13px]" />}
                        onClick={() => setArchiveOpen(true)}
                      >
                        History
                      </RailRow>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          <div className="flex-1" />
          <button
            onClick={onShowShortcuts}
            className="flex items-center gap-1.5 px-1.5 text-[10.5px] text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            <Kbd>?</Kbd> all shortcuts
          </button>
        </div>
      </DialogContent>
      {archiveOpen && (
        <ArchiveDialog task={task} onClose={() => setArchiveOpen(false)} />
      )}
    </Dialog>
  );
}

// ── Shared pickers + rail/chip primitives (edit rail ⇄ create chips) ──

/** Picker popover chrome: Radix would focus the content wrapper, leaving
 *  cmdk deaf to arrow keys — land focus on the search input (or the command
 *  root for list-only pickers) so keyboard-opened pickers work immediately. */
function PickerContent({
  className,
  ...props
}: React.ComponentProps<typeof PopoverContent>) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <PopoverContent
      ref={ref}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        ref.current
          ?.querySelector<HTMLElement>("[cmdk-input], [cmdk-root]")
          ?.focus();
      }}
      className={cn("p-0", className)}
      {...props}
    />
  );
}

/** Inline number input for points/hours estimates (rail row + create chip).
 *  Enter/blur commits (empty = clear → null), Esc cancels. */
function InlineEstimateInput({
  initial,
  unit,
  onCommit,
  onCancel,
  className,
}: {
  initial: string;
  unit: EstimateUnit;
  onCommit: (value: number | null) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(initial);
  const commit = () => {
    const raw = draft.trim();
    if (raw === "") return onCommit(null);
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) onCommit(v);
    else onCancel();
  };
  return (
    <input
      type="number"
      min={0}
      step={unit === "hours" ? 0.5 : 1}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          // stopPropagation: ⌘↵ here commits the estimate, not the dialog
          // (the dialog's save would still read the pre-commit state).
          e.preventDefault();
          e.stopPropagation();
          commit();
        }
        if (e.key === "Escape") {
          // Cancel the edit without closing the dialog.
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
      placeholder={unit === "hours" ? "Hours…" : "Points…"}
      className={className}
    />
  );
}

/** Tiny keyboard-shortcut chip (matches the mock's kbd styling). */
function Kbd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "shrink-0 rounded border border-border px-1 font-mono text-[9.5px] leading-4 text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** One properties-rail row: icon + value + right-aligned key hint. */
function RailRow({
  icon,
  kbd,
  muted,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & {
  icon: React.ReactNode;
  kbd?: string;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-accent/50",
        muted ? "text-muted-foreground" : "text-foreground",
        className,
      )}
    >
      <span className="flex size-[13px] shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {kbd && <Kbd>{kbd}</Kbd>}
    </button>
  );
}

/** Create-dialog property chip: icon + value (or label) + key hint. Chips
 *  with a value render filled; unset ones are border-only and muted. */
function CreateChip({
  icon,
  kbd,
  set,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & {
  icon: React.ReactNode;
  kbd: string;
  set?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] transition-colors disabled:pointer-events-none disabled:opacity-50",
        set
          ? "border-border bg-accent text-foreground"
          : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        className,
      )}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="max-w-56 truncate">{children}</span>
      <Kbd>{kbd}</Kbd>
    </button>
  );
}

/** Column-role → card-state glyph when there's no task context (pickers). */
function roleToState(role: ColumnRole): CardState {
  return role === "done"
    ? "done"
    : role === "review"
      ? "review"
      : role === "active"
        ? "working"
        : role === "queued"
          ? "queued"
          : "todo";
}

/** Dependency candidates: peers only — siblings for a subtask, other
 *  top-level tasks otherwise — excluding itself and done-column tasks. */
function depCandidates(task: Task, ctx: BoardCtx): Task[] {
  return [...ctx.taskById.values()]
    .filter(
      (t) =>
        t.id !== task.id &&
        t.parentId === task.parentId &&
        ctx.roleById.get(t.columnId) !== "done",
    )
    .sort(byNumber);
}

/** "8 points" / "4h" / "M" — display for a set estimate. */
function estimateLabel(value: number, unit: EstimateUnit): string {
  if (unit === "tshirt") return formatEstimate(value, unit);
  return unit === "hours"
    ? `${formatEstimate(value, unit)}h`
    : `${formatEstimate(value, unit)} points`;
}

/** Column list picker (the status/column property). */
function ColumnPicker({
  columns,
  onSelect,
}: {
  columns: BoardColumn[];
  onSelect: (c: BoardColumn) => void;
}) {
  return (
    <Command>
      <CommandList className="p-1">
        {columns.map((c) => (
          <CommandItem
            key={c.id}
            value={c.name}
            onSelect={() => onSelect(c)}
            className="gap-2"
          >
            <StateIcon state={roleToState(c.role)} />
            {c.name}
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}

/** Project picker ("" = no project → quick chat). */
function ProjectPicker({
  projects,
  onSelect,
}: {
  projects: ProjectView[];
  onSelect: (id: string) => void;
}) {
  return (
    <Command>
      <CommandInput placeholder="Project…" />
      <CommandSeparator className="mt-1" />
      <CommandList className="max-h-56 p-1">
        <CommandEmpty>No matching projects.</CommandEmpty>
        <CommandItem value="No project" onSelect={() => onSelect("")}>
          No project (starts a quick chat)
        </CommandItem>
        {projects.map((p) => (
          <CommandItem
            key={p.id}
            value={`${p.name} ${p.id}`}
            onSelect={() => onSelect(p.id)}
          >
            <span className="truncate">{p.name}</span>
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}

/** T-shirt estimate picker (points/hours edit inline instead — no popover).
 *  Selecting -1 clears (the backend's unset sentinel). */
function EstimatePicker({ onSelect }: { onSelect: (value: number) => void }) {
  return (
    <Command>
      <CommandList className="p-1">
        {TSHIRT_SIZES.map((s) => (
          <CommandItem
            key={s.label}
            value={s.label}
            onSelect={() => onSelect(s.value)}
            className="gap-2"
          >
            {s.label}
          </CommandItem>
        ))}
        <CommandItem
          value="No estimate"
          onSelect={() => onSelect(-1)}
          className="text-muted-foreground"
        >
          No estimate
        </CommandItem>
      </CommandList>
    </Command>
  );
}

/** Removable `#N title` chip for the Blocked by / Blocks lists. */
function DepEditChip({ task, onRemove }: { task: Task; onRemove: () => void }) {
  return (
    <span
      className={cn(CHIP, "max-w-44 border-border text-muted-foreground")}
      title={`#${task.number} ${task.title}`}
    >
      <span className="shrink-0 font-mono">#{task.number}</span>
      <span className="min-w-0 truncate">{task.title}</span>
      <button
        onClick={onRemove}
        className="shrink-0 rounded-full hover:text-foreground"
        title="Remove"
      >
        <X className="size-2.5" />
      </button>
    </span>
  );
}

/** Searchable dependency picker body (shared by the edit rail's popovers and
 *  the create dialog's Blocked-by chip). */
function DepPickerContent({
  candidates,
  selected,
  onSelect,
}: {
  candidates: Task[];
  /** When given, items render toggle checks and stay open (create flow). */
  selected?: Set<string>;
  onSelect: (t: Task) => void;
}) {
  return (
    <Command>
      <CommandInput placeholder="Search tasks…" />
      <CommandSeparator className="mt-1" />
      <CommandList className="max-h-56 p-1">
        <CommandEmpty>No matching tasks.</CommandEmpty>
        {candidates.map((t) => (
          <CommandItem
            key={t.id}
            value={`#${t.number} ${t.title}`}
            onSelect={() => onSelect(t)}
            className="gap-2"
          >
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              #{t.number}
            </span>
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            {selected?.has(t.id) && (
              <CircleCheck className="size-3.5 shrink-0 text-primary" />
            )}
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}

// ── Activity feed (timeline events + comments + the /command composer) ──

/** Feed timestamp: time-of-day for today, short date otherwise. */
function formatWhen(ts: number): string {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Event glyph, colored by actor (user muted, agent green, ai primary) with
 *  kind overrides (review purple, done green). */
function ActivityIcon({ kind, actor }: { kind: string; actor: string }) {
  const color =
    kind === "review"
      ? REVIEW_TEXT
      : kind === "done"
        ? "text-additions"
        : actor === "ai"
          ? "text-primary"
          : actor === "agent"
            ? "text-additions"
            : "text-muted-foreground";
  const Icon =
    kind === "plan"
      ? Sparkles
      : kind === "session"
        ? Play
        : kind === "review" || kind === "done"
          ? CircleCheck
          : kind === "resumed"
            ? Undo2
            : kind === "moved"
              ? ArrowRight
              : Circle; // created + unknown kinds
  return (
    // Opaque backing so the icon masks the timeline's vertical line.
    <span className="relative flex size-[15px] shrink-0 items-center justify-center rounded-full bg-popover">
      <Icon className={cn("size-3.5", color)} />
    </span>
  );
}

/** One-line text per recorded event kind. */
function activityText(entry: ActivityEntry): React.ReactNode {
  switch (entry.kind) {
    case "created":
      return "created the task";
    case "plan":
      return entry.body || "planned subtasks";
    case "session":
      return "session started";
    case "review":
      return (
        <>
          agent finished a turn — moved to{" "}
          <span className={REVIEW_TEXT}>Needs review</span>
        </>
      );
    case "resumed":
      return "moved back to In progress";
    case "moved":
      return `moved to ${entry.body}`;
    case "done":
      return entry.body ? `done — ${entry.body}` : "moved to Done";
    default:
      return entry.body;
  }
}

/** The task's timeline (thin vertical line): event rows, comment bubbles, and
 *  the comment/command composer. Fetched on open, refetched on every
 *  `tasks:changed` while the dialog is up. */
function ActivityFeed({
  task,
  composerRef,
}: {
  task: Task;
  /** The dialog's `/` shortcut focuses (and seeds) the composer through this. */
  composerRef?: React.RefObject<{ focusSlash: () => void } | null>;
}) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef<number | null>(null);

  useEffect(() => {
    if (!composerRef) return;
    composerRef.current = {
      focusSlash: () => {
        inputRef.current?.focus();
        // Seed the slash so the command hint shows (the keydown itself was
        // preventDefault-ed to avoid typing it twice).
        setDraft((d) => (d === "" ? "/" : d));
      },
    };
  }, [composerRef]);

  useEffect(() => {
    let live = true;
    const refetch = () =>
      void taskActivity(task.id).then((a) => live && setEntries(a));
    refetch();
    // Fresh closure per mount (see the board subscription note above).
    const unlisten = onTasksChanged(() => refetch());
    return () => {
      live = false;
      void unlisten.then((f) => f());
    };
  }, [task.id]);

  // Auto-scroll to the newest entry — but never on the initial load, so
  // opening the dialog doesn't jump past the description.
  useEffect(() => {
    if (prevCount.current !== null && entries.length > prevCount.current)
      bottomRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    prevCount.current = entries.length;
  }, [entries.length]);

  const submit = () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    taskComment(task.id, body)
      .then(() => {
        setDraft("");
        return taskActivity(task.id).then(setEntries);
      })
      // Keep the draft on failure so a mistyped /command can be fixed.
      .catch((e) => toast.error(String(e)))
      .finally(() => setSending(false));
  };

  return (
    <div className="flex flex-col">
      <div className="pb-2.5 text-xs font-medium tracking-wide text-muted-foreground">
        ACTIVITY
      </div>
      <div className="relative flex flex-col">
        <div className="absolute bottom-3 left-[7px] top-2 w-px bg-border/70" />

        {entries.map((entry) =>
          entry.kind === "comment" || entry.kind === "command" ? (
            <div key={entry.id} className="relative flex gap-3 py-2">
              <span className="relative mt-1.5 flex size-[15px] shrink-0 items-center justify-center rounded-full bg-primary text-[8.5px] font-bold text-primary-foreground">
                M
              </span>
              <div className="min-w-0 flex-1 rounded-lg border border-border bg-accent/40 px-3 py-2">
                <div className="pb-1 text-[10.5px] text-muted-foreground">
                  {formatWhen(entry.createdAt)}
                </div>
                {entry.kind === "command" ? (
                  <div className="font-mono text-xs leading-relaxed">
                    <span className="text-primary">
                      {entry.body.split(/\s+/, 1)[0]}
                    </span>
                    {entry.body.slice(entry.body.split(/\s+/, 1)[0].length)}
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap text-xs leading-relaxed">
                    {entry.body}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div
              key={entry.id}
              className="relative flex items-center gap-3 py-1 text-xs text-muted-foreground"
            >
              <ActivityIcon kind={entry.kind} actor={entry.actor} />
              <span className="min-w-0 flex-1">{activityText(entry)}</span>
              <span className="shrink-0 text-[10.5px] text-muted-foreground/60">
                {formatWhen(entry.createdAt)}
              </span>
            </div>
          ),
        )}
        <div ref={bottomRef} />

        {/* Composer */}
        <div className="relative flex gap-3 pt-2.5">
          <span className="relative mt-2 flex size-[15px] shrink-0 items-center justify-center rounded-full bg-primary text-[8.5px] font-bold text-primary-foreground">
            M
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 transition-colors focus-within:border-ring">
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter and ⌘Enter both submit.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="Leave a comment — / for commands…"
                className="min-w-0 flex-1 bg-transparent py-1 text-xs outline-none placeholder:text-muted-foreground"
              />
              {sending ? (
                <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <Kbd>⌘↵</Kbd>
              )}
            </div>
            {draft.startsWith("/") && (
              <p className="pt-1 text-[10.5px] text-muted-foreground">
                /start [instructions] · /send &lt;message&gt; · /stop · /done
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── The "?" shortcuts overlay ──

const BOARD_SHORTCUTS: [string, string][] = [
  ["New task", "N"],
  ["Move focus", "← ↑ ↓ →"],
  ["Open task", "Space"],
  ["Back / close", "Esc"],
  ["Filter", "F"],
];
const TASK_SHORTCUTS: [string, string][] = [
  ["Status / column", "S"],
  ["Project", "P"],
  ["Estimate", "E"],
  ["Blocked by / blocks", "B · ⇧B"],
  ["Add subtask", "A"],
  ["Open / start session", "O"],
  ["Focus comment", "/"],
  ["Comment / save", "⌘↵"],
];

/** The shortcut map: board keys on the left, task-dialog keys on the right.
 *  Opened with "?" from the board or the task view. */
function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const col = (label: string, rows: [string, string][]) => (
    <div className="flex flex-1 flex-col gap-2">
      <div className="pb-0.5 text-[10.5px] font-semibold tracking-wide text-muted-foreground">
        {label}
      </div>
      {rows.map(([name, key]) => (
        <div
          key={name}
          className="flex items-center justify-between gap-4 text-xs"
        >
          <span>{name}</span>
          <Kbd>{key}</Kbd>
        </div>
      ))}
    </div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(34rem,90vw)] sm:max-w-none">
        <DialogTitle className="sr-only">Keyboard shortcuts</DialogTitle>
        <div className="flex gap-6 py-1">
          {col("BOARD", BOARD_SHORTCUTS)}
          <div className="w-px shrink-0 bg-border" />
          {col("TASK", TASK_SHORTCUTS)}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Subtask list + AI "Suggest plan" + rapid add input. */
function SubtasksSection({
  task,
  ctx,
  unit,
  workspaces,
  sessions,
  prs,
  onOpenSession,
  onOpen,
  addInputRef,
}: {
  task: Task;
  ctx: BoardCtx;
  /** Effective estimate unit (subtasks share the parent's project). */
  unit: EstimateUnit;
  workspaces: Map<string, Workspace>;
  sessions: Record<string, SessionPayload>;
  prs: Record<string, PrPayload>;
  onOpenSession: (workspaceId: string) => void;
  /** Clicking a row switches the dialog to that subtask. */
  onOpen: (t: Task) => void;
  /** The dialog's `A` shortcut focuses the add input through this ref. */
  addInputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const children = [...(ctx.childrenByParent.get(task.id) ?? [])].sort(
    byNumber,
  );
  const [draft, setDraft] = useState("");
  const [planning, setPlanning] = useState(false);

  // Header mini progress bar: same segments/order as the card's subtask bar.
  const doneKids = children.filter(
    (c) => ctx.roleById.get(c.columnId) === "done",
  ).length;
  const segStates = children
    .map((c) => deriveState(c, ctx.roleById.get(c.columnId) ?? "none"))
    .sort((a, b) => SEG_ORDER[a] - SEG_ORDER[b]);

  const fail = (e: unknown) =>
    toast.error("Could not add subtask", { description: String(e) });

  /** Create in order — numbers follow creation. */
  const add = async (titles: string[]) => {
    for (const title of titles) await taskCreate(title, { parentId: task.id });
  };

  const suggestPlan = () => {
    setPlanning(true);
    taskSuggestPlan(task.id)
      .then(({ updated, notes }) =>
        toast.success(`Planned ${updated} subtasks`, {
          description: notes ?? undefined,
        }),
      )
      .catch((e) =>
        toast.error("Could not suggest a plan", { description: String(e) }),
      )
      .finally(() => setPlanning(false));
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 pb-1.5">
        <span className="text-xs font-medium tracking-wide text-muted-foreground">
          SUBTASKS
        </span>
        {children.length > 0 && (
          <>
            <span className="flex h-1 w-16 gap-px overflow-hidden rounded-full">
              {segStates.map((s, i) => (
                <span key={i} className={cn("h-full flex-1", SEG_COLOR[s])} />
              ))}
            </span>
            <span className="text-[10.5px] text-muted-foreground">
              {doneKids}/{children.length}
            </span>
          </>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={suggestPlan}
          disabled={planning}
          title="AI orders the subtasks (blocked-by) and estimates their size"
        >
          {planning ? (
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 size-3.5" />
          )}
          Suggest plan
        </Button>
      </div>

      {children.map((child) => {
        const role = ctx.roleById.get(child.columnId) ?? "none";
        const ws = child.workspaceId
          ? workspaces.get(child.workspaceId)
          : undefined;
        const unmet = firstUnmetDep(child, ctx);
        return (
          <div
            key={child.id}
            onClick={() => onOpen(child)}
            title="Open this subtask"
            className="-mx-1 flex cursor-pointer items-center gap-2 rounded-md border-b border-border/50 px-1 py-1.5 hover:bg-accent/40"
          >
            <StateIcon state={deriveState(child, role)} />
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              #{child.number}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              {child.title}
            </span>
            {child.estimate !== null && (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {formatEstimate(child.estimate, unit)}
              </span>
            )}
            {ws && (
              <StatusChip
                state={deriveState(child, role)}
                workspace={ws}
                session={
                  child.workspaceId ? sessions[child.workspaceId] : undefined
                }
                pr={child.workspaceId ? prs[child.workspaceId] : undefined}
                onOpenSession={onOpenSession}
              />
            )}
            {unmet && <DepChip number={unmet.number} />}
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <input
          ref={addInputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const title = draft.trim();
            if (!title) return;
            setDraft("");
            void add([title]).catch(fail);
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (!text.includes("\n")) return;
            e.preventDefault();
            // Split a pasted list: one subtask per line, list markers stripped.
            const lines = text
              .split("\n")
              .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
              .filter(Boolean);
            if (lines.length) void add(lines).catch(fail);
          }}
          placeholder="Add a subtask — Enter to keep adding, paste a list to split it…"
          className="h-9 min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
        />
        <Kbd>A</Kbd>
      </div>
    </div>
  );
}

/** Read-only view of a linked session whose workspace was deleted — the
 *  transcript lives on in chat.db, keyed by the (kept) workspace id. */
function ArchiveDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  useEffect(() => {
    if (!task.workspaceId) return;
    chatArchive(task.workspaceId)
      .then((snap) => setEntries(snap.entries))
      .catch((e) => {
        onClose();
        toast.error("Could not load the archived chat", {
          description: String(e),
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.workspaceId]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[80vh] w-[min(60rem,92vw)] flex-col sm:max-w-none">
        <div className="border-b border-border pb-4">
          <DialogTitle className="text-xl">{task.title}</DialogTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Archived conversation — the workspace was cleaned up.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {entries === null ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading transcript…
            </div>
          ) : entries.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground">
              No messages were recorded for this session.
            </div>
          ) : (
            <div className="flex flex-col gap-3 py-2">
              {entries.map((entry) =>
                entry.type === "user" ? (
                  <UserMessageView key={entry.entryId} entry={entry} />
                ) : entry.type === "assistant" ? (
                  <AssistantTurnView key={entry.entryId} entry={entry} />
                ) : (
                  <SystemMessageView key={entry.entryId} entry={entry} />
                ),
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
