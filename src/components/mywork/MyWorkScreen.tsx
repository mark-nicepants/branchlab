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
import { ChevronLeft, ListFilter, Plus } from "lucide-react";
import { toast } from "sonner";
import { boardSnapshot, taskCreate, taskMove } from "../../lib/api";
import { onTasksChanged } from "../../lib/events";
import type {
  BoardColumn,
  DiffStat,
  BoardSnapshot,
  PrPayload,
  ProjectView,
  SessionPayload,
  Task,
  Workspace,
} from "../../lib/types";
import {
  buildBoardCtx,
  positionAtEnd,
  positionBefore,
  type BoardCtx,
} from "../../lib/board";
import { TaskCard, type DropSpot } from "./TaskCard";
import { ArchiveDialog } from "./ArchiveDialog";
import { TaskCreateDialog, type CreateState } from "./TaskCreateDialog";
import { TaskEditDialog } from "./TaskEditDialog";
import { useWorkspaceData } from "../../hooks/useWorkspaceData";
import { useProjects } from "../../hooks/useProjects";
import { hasOpenOverlay } from "../../lib/overlay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

interface Props {
  onOpenSession: (workspaceId: string) => void;
  /** Spawn a session for this task (App links the workspace back to it). */
  onStartTask: (task: Task) => void;
  /** Delete a task's workspace (the done-column cleanup offer). */
  onCleanupWorkspace: (workspaceId: string) => void;
  /** Focus this card on mount (the session header's task chip jump). */
  focusTaskId: string | null;
  onFocusTaskHandled: () => void;
}

/** Create-or-edit dialog state. */
type DialogState = CreateState | { mode: "edit"; task: Task };

export function MyWorkScreen({
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
  const { projects, workspaceById, projectById } = useProjects();

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
    // Passive seed: on failure the board stays empty until tasks:changed.
    void boardSnapshot()
      .then((s) => live && setBoard(s))
      .catch(() => {});
    // Fresh closure per mount: the mock event bus stores handlers in a Set,
    // so passing the stable setter would let StrictMode's first-unmount
    // cleanup delete the second mount's identical subscription.
    const unlisten = onTasksChanged((s) => setBoard(s));
    return () => {
      live = false;
      void unlisten.then((f) => f());
    };
  }, []);

  const boardCtx = useMemo<BoardCtx>(
    () => buildBoardCtx(board.tasks, board.columns),
    [board],
  );
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
      const ws = task?.workspaceId ? workspaceById.get(task.workspaceId) : null;
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
    [board.columns, board.tasks, workspaceById, onCleanupWorkspace],
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
      const end = positionAtEnd(board.tasks, doneCol.id);
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
                    {projectById.get(projectFilter)?.name ?? "Project"}
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
              projectById={projectById}
              workspaces={workspaceById}
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
          workspaces={workspaceById}
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
  projectById,
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
  projectById: Map<string, ProjectView>;
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
                task.projectId
                  ? projectById.get(task.projectId)?.name
                  : undefined
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
