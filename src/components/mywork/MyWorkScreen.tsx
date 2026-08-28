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
  ChevronLeft,
  CircleDot,
  Clock,
  CloudDownload,
  GitPullRequest,
  Loader2,
  Lock,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import {
  boardSnapshot,
  chatArchive,
  listProjectIssues,
  taskCreate,
  taskDelete,
  taskMove,
  taskSuggestPlan,
  taskUpdate,
} from "../../lib/api";
import { onTasksChanged } from "../../lib/events";
import type {
  BoardColumn,
  ColumnRole,
  DiffStat,
  Entry,
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
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
  const [board, setBoard] = useState<BoardSnapshot>({ columns: [], tasks: [] });
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
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
      {/* Traffic-light clearance + title row (drag region like Home). */}
      <div data-tauri-drag-region className="h-10 shrink-0" />
      {drillParent ? (
        // Drill-down breadcrumb replaces the title + filter row.
        <div className="flex items-center gap-2 px-6 pb-4">
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
          <div className="flex-1" />
          <span className="shrink-0 text-xs text-muted-foreground">
            {drillDone} of {drillChildren.length} done
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-3 px-6 pb-4">
          <h1 className="text-lg font-semibold">My work</h1>
          <div className="flex items-center gap-1.5">
            <FilterChip
              label="All"
              active={projectFilter === null}
              onClick={() => setProjectFilter(null)}
            />
            {filterProjects.map((p) => (
              <FilterChip
                key={p.id}
                label={p.name}
                active={projectFilter === p.id}
                onClick={() =>
                  setProjectFilter((cur) => (cur === p.id ? null : p.id))
                }
              />
            ))}
          </div>
          <div className="flex-1" />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-x-auto px-6 pb-6">
        <div className="flex h-full items-stretch gap-4">
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
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.mode === "edit" && (
        <TaskEditDialog
          // Re-resolve on every snapshot so per-field commits render back live.
          task={boardCtx.taskById.get(dialog.task.id) ?? dialog.task}
          ctx={boardCtx}
          projects={projects}
          workspaces={allWorkspaces}
          sessions={sessionByWorkspace}
          prs={prByWorkspace}
          onOpenSession={onOpenSession}
          onClose={() => setDialog(null)}
        />
      )}
      {archiveFor && (
        <ArchiveDialog task={archiveFor} onClose={() => setArchiveFor(null)} />
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "max-w-48 truncate rounded-full border px-2.5 py-0.5 text-xs transition-colors",
        active
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {label}
    </button>
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
      className="group/subtasks mt-2 flex w-full items-center gap-1.5"
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
  const showArchive = !isParent && !!task.workspaceId && !workspace;
  const hasFooter =
    showPr !== null || showDiff || showArchive || unmetDep !== null;

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
        {!isParent && (
          <StatusChip
            state={state}
            workspace={workspace}
            session={session}
            pr={pr}
            onOpenSession={onOpenSession}
          />
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
          {showArchive && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenArchive(task);
              }}
              className={cn(
                CHIP,
                "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              title="The workspace is gone; open the archived conversation"
            >
              <MessageSquare className="size-2.5" />
              chat archive
            </button>
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

/** Create dialog. Settings-dialog sized — the space grows into richer task
 *  detail over time. Editing an existing task opens TaskEditDialog instead. */
function TaskCreateDialog({
  state,
  projects,
  onClose,
}: {
  state: Extract<DialogState, { mode: "create" }>;
  projects: ProjectView[];
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  // GitHub import: a searchable dropdown of the repo's open issues
  // (already sorted newest-updated first by the backend).
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [loadingIssues, setLoadingIssues] = useState(false);
  /** GitHub Projects estimate carried from the imported issue, if any. */
  const [importEstimate, setImportEstimate] = useState<number | null>(null);

  const openIssuePicker = (open: boolean) => {
    setIssuesOpen(open);
    if (open && issues === null && projectId) {
      setLoadingIssues(true);
      listProjectIssues(projectId)
        .then(setIssues)
        .catch((e) => {
          setIssuesOpen(false);
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
    setIssuesOpen(false);
  };

  const save = () => {
    if (!title.trim()) return;
    taskCreate(title.trim(), {
      description: description || undefined,
      // Subtasks inherit the parent's project server-side.
      projectId: state.parentId ? undefined : projectId || undefined,
      columnId: state.columnId,
      parentId: state.parentId ?? undefined,
    })
      .then((created) =>
        // taskCreate has no estimate arg — the imported issue's GitHub
        // Projects estimate lands via a follow-up patch.
        importEstimate !== null
          ? taskUpdate(created.id, { estimate: importEstimate })
          : undefined,
      )
      .then(onClose)
      .catch((e) =>
        toast.error("Could not save task", { description: String(e) }),
      );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[80vh] w-[min(60rem,92vw)] flex-col sm:max-w-none">
        {/* A real header band: larger title, breathing room, hairline below. */}
        <div className="border-b border-border pb-4">
          <DialogTitle className="text-xl">
            {state.parentId ? "New subtask" : "New task"}
          </DialogTitle>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-5 pt-2">
          <Field label="Title">
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder="What needs doing?"
            />
          </Field>
          {state.parentId ? (
            <p className="text-xs text-muted-foreground">
              Inherits the parent task's project.
            </p>
          ) : (
            <div className="flex items-end gap-3">
              <Field label="Project">
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="h-9 w-72 rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  <option value="">No project (starts a quick chat)</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Popover open={issuesOpen} onOpenChange={openIssuePicker}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!projectId}
                    title={
                      projectId
                        ? "Fill this task from an open GitHub issue"
                        : "Select a project first"
                    }
                  >
                    <CloudDownload className="mr-1.5 size-3.5" />
                    Import from GitHub
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[28rem] p-0">
                  <Command>
                    <CommandInput placeholder="Search open issues…" />
                    <CommandList className="max-h-72">
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
                </PopoverContent>
              </Popover>
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col">
            <Field label="Description" className="flex min-h-0 flex-1 flex-col">
              <MarkdownEditor
                value={description}
                onChange={setDescription}
                placeholder="Optional — markdown, included in the session prompt."
                className="flex-1"
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!title.trim()}>
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Edit dialog: opens in VIEW mode — big title (click to rename), rendered
 *  markdown description (pencil / double-click to edit), always-live project
 *  select, and the subtasks section. Every field commits independently. */
function TaskEditDialog({
  task,
  ctx,
  projects,
  workspaces,
  sessions,
  prs,
  onOpenSession,
  onClose,
}: {
  task: Task;
  ctx: BoardCtx;
  projects: ProjectView[];
  workspaces: Map<string, Workspace>;
  sessions: Record<string, SessionPayload>;
  prs: Record<string, PrPayload>;
  onOpenSession: (workspaceId: string) => void;
  onClose: () => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");

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

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[80vh] w-[min(60rem,92vw)] flex-col sm:max-w-none">
        <div className="border-b border-border pb-4">
          <div className="font-mono text-xs text-muted-foreground">
            Task #{task.number}
          </div>
          {editingTitle ? (
            <>
              <DialogTitle className="sr-only">
                Task #{task.number}
              </DialogTitle>
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
                className="mt-0.5 h-auto rounded-none border-transparent bg-transparent px-0 py-0.5 text-xl font-semibold shadow-none focus-visible:ring-0 md:text-xl dark:bg-transparent"
              />
            </>
          ) : (
            <DialogTitle
              className="mt-0.5 cursor-text py-0.5 text-xl"
              onClick={startTitleEdit}
              title="Click to rename"
            >
              {task.title}
            </DialogTitle>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-1 pt-2">
          <Field label="Project">
            <select
              value={task.projectId ?? ""}
              onChange={(e) =>
                taskUpdate(task.id, { projectId: e.target.value }).catch(fail)
              }
              className="h-9 w-72 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="">No project (starts a quick chat)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          <TaskMetaRow task={task} ctx={ctx} />

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
              workspaces={workspaces}
              sessions={sessions}
              prs={prs}
              onOpenSession={onOpenSession}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Compact metadata row (interim — a popup redesign comes later): the hour
 *  estimate plus both directions of the blocked-by relation. Every field
 *  commits independently; the board snapshot renders the result back live. */
function TaskMetaRow({ task, ctx }: { task: Task; ctx: BoardCtx }) {
  const fail = (e: unknown) =>
    toast.error("Could not save task", { description: String(e) });

  // Dependency candidates: peers only — siblings for a subtask, other
  // top-level tasks otherwise — excluding itself and done-column tasks.
  const live = [...ctx.taskById.values()];
  const peers = live
    .filter(
      (t) =>
        t.id !== task.id &&
        t.parentId === task.parentId &&
        ctx.roleById.get(t.columnId) !== "done",
    )
    .sort(byNumber);
  const blockedBy = task.dependsOn
    .map((id) => ctx.taskById.get(id))
    .filter((t): t is Task => t !== undefined);
  const blocks = live.filter((t) => t.dependsOn.includes(task.id)).sort(byNumber);

  return (
    <div className="flex flex-wrap items-start gap-8">
      <Field label="Estimate">
        <EstimateInput task={task} onError={fail} />
      </Field>
      <Field label="Blocked by">
        <div className="flex min-h-8 flex-wrap items-center gap-1.5">
          {blockedBy.map((dep) => (
            <DepEditChip
              key={dep.id}
              task={dep}
              onRemove={() =>
                taskUpdate(task.id, {
                  dependsOn: task.dependsOn.filter((id) => id !== dep.id),
                }).catch(fail)
              }
            />
          ))}
          <DepPicker
            candidates={peers.filter((t) => !task.dependsOn.includes(t.id))}
            onSelect={(dep) =>
              taskUpdate(task.id, {
                dependsOn: [...task.dependsOn, dep.id],
              }).catch(fail)
            }
          />
        </div>
      </Field>
      <Field label="Blocks">
        <div className="flex min-h-8 flex-wrap items-center gap-1.5">
          {blocks.map((other) => (
            <DepEditChip
              key={other.id}
              task={other}
              onRemove={() =>
                taskUpdate(other.id, {
                  dependsOn: other.dependsOn.filter((id) => id !== task.id),
                }).catch(fail)
              }
            />
          ))}
          <DepPicker
            candidates={peers.filter((t) => !t.dependsOn.includes(task.id))}
            onSelect={(other) =>
              taskUpdate(other.id, {
                dependsOn: [...other.dependsOn, task.id],
              }).catch(fail)
            }
          />
        </div>
      </Field>
    </div>
  );
}

/** Hour-estimate input: commits on blur/Enter; clearing it commits the
 *  negative unset sentinel. */
function EstimateInput({
  task,
  onError,
}: {
  task: Task;
  onError: (e: unknown) => void;
}) {
  const [draft, setDraft] = useState(task.estimate?.toString() ?? "");
  // Re-sync when another commit (or Suggest plan) changes the live value.
  useEffect(() => setDraft(task.estimate?.toString() ?? ""), [task.estimate]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (task.estimate !== null)
        taskUpdate(task.id, { estimate: -1 }).catch(onError);
      return;
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0) {
      setDraft(task.estimate?.toString() ?? "");
      return;
    }
    if (value !== task.estimate)
      taskUpdate(task.id, { estimate: value }).catch(onError);
  };

  return (
    <div className="relative w-24">
      <Input
        type="number"
        min={0}
        step={0.5}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        placeholder="—"
        className="h-8 pr-7 text-sm"
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
        h
      </span>
    </div>
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

/** "+ Add" dependency picker: a searchable popover over the candidate peers
 *  (same pattern as the GitHub issue import picker). */
function DepPicker({
  candidates,
  onSelect,
}: {
  candidates: Task[];
  onSelect: (t: Task) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            CHIP,
            "border-dashed border-border text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
          title="Add a task"
        >
          <Plus className="size-2.5" />
          Add
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Search tasks…" />
          <CommandList className="max-h-56">
            <CommandEmpty>No matching tasks.</CommandEmpty>
            {candidates.map((t) => (
              <CommandItem
                key={t.id}
                value={`#${t.number} ${t.title}`}
                onSelect={() => {
                  setOpen(false);
                  onSelect(t);
                }}
                className="gap-2"
              >
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  #{t.number}
                </span>
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Subtask list + AI "Suggest plan" + rapid add input. */
function SubtasksSection({
  task,
  ctx,
  workspaces,
  sessions,
  prs,
  onOpenSession,
}: {
  task: Task;
  ctx: BoardCtx;
  workspaces: Map<string, Workspace>;
  sessions: Record<string, SessionPayload>;
  prs: Record<string, PrPayload>;
  onOpenSession: (workspaceId: string) => void;
}) {
  const children = [...(ctx.childrenByParent.get(task.id) ?? [])].sort(
    byNumber,
  );
  const [draft, setDraft] = useState("");
  const [planning, setPlanning] = useState(false);

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
      <div className="flex items-center gap-3 pb-1.5">
        <span className="text-xs font-medium tracking-wide text-muted-foreground">
          SUBTASKS · {children.length}
        </span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={suggestPlan}
          disabled={planning}
          title="AI orders the subtasks (blocked-by) and estimates their hours"
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
            className="flex items-center gap-2 border-b border-border/50 py-1.5"
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
                {child.estimate}h
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

      <input
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
        className="h-9 bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
      />
      <p className="pt-1 text-xs text-muted-foreground">
        Drag a subtask on the board like any card. The parent moves to Done
        when the last child lands.
      </p>
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
