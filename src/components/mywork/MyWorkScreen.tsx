// "My work" — a lightweight kanban board over the backend TaskStore
// (src-tauri/src/tasks.rs). Local state seeds from `boardSnapshot()` and every
// mutation comes back authoritatively via the `tasks:changed` event; drags
// apply optimistically in between. Ordering uses fractional positions — the
// frontend computes midpoints, the backend renumbers when gaps exhaust.
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
  CircleDot,
  CloudDownload,
  GripVertical,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Play,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import {
  boardSnapshot,
  columnCreate,
  columnDelete,
  columnMove,
  columnUpdate,
  listProjectIssues,
  taskCreate,
  taskDelete,
  taskMove,
  taskUpdate,
} from "../../lib/api";
import { onTasksChanged } from "../../lib/events";
import type {
  BoardColumn,
  IssueSummary,
  BoardSnapshot,
  PrPayload,
  ProjectView,
  SessionPayload,
  Task,
  Workspace,
} from "../../lib/types";
import { useWorkspaceData } from "../../hooks/useWorkspaceData";
import { hasOpenOverlay } from "../session/SessionView";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface Props {
  projects: ProjectView[];
  onOpenSession: (workspaceId: string) => void;
  /** Spawn a session for this task (App links the workspace back to it). */
  onStartTask: (task: Task) => void;
}

/** Where a dragged card would land: before `before`, or at the end (null). */
interface DropSpot {
  columnId: string;
  before: string | null;
}

/** Create-or-edit dialog state. */
type DialogState =
  | { mode: "create"; columnId: string }
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

export function MyWorkScreen({ projects, onOpenSession, onStartTask }: Props) {
  const [board, setBoard] = useState<BoardSnapshot>({ columns: [], tasks: [] });
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropSpot, setDropSpot] = useState<DropSpot | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const { sessionByWorkspace, prByWorkspace } = useWorkspaceData();

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
    () => new Map(projects.flatMap((p) => p.workspaces).map((w) => [w.id, w])),
    [projects],
  );
  const projectNames = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects],
  );
  // Filter chips: only projects that actually have cards.
  const filterProjects = useMemo(
    () => projects.filter((p) => board.tasks.some((t) => t.projectId === p.id)),
    [projects, board.tasks],
  );
  const visibleTasks = useMemo(
    () =>
      projectFilter
        ? board.tasks.filter((t) => t.projectId === projectFilter)
        : board.tasks,
    [board.tasks, projectFilter],
  );
  /** Visible tasks per column, in board order (the keyboard grid). */
  const grid = useMemo(
    () =>
      board.columns.map((c) =>
        visibleTasks.filter((t) => t.columnId === c.id),
      ),
    [board.columns, visibleTasks],
  );

  const moveTask = useCallback(
    (taskId: string, columnId: string, position: number) => {
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
    [],
  );

  const addColumn = useCallback(() => {
    const name = window.prompt("Column name");
    if (name?.trim())
      columnCreate(name).catch((e) =>
        toast.error("Could not add column", { description: String(e) }),
      );
  }, []);

  // ── Keyboard: N = new task; arrows move card focus; Space/Enter opens. ──
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
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        const first = board.columns[0];
        if (first) setDialog({ mode: "create", columnId: first.id });
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
  }, [grid, focusedId, dialog, board.columns]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Traffic-light clearance + title row (drag region like Home). */}
      <div data-tauri-drag-region className="h-10 shrink-0" />
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
        <Button variant="outline" size="sm" onClick={addColumn}>
          <Plus className="mr-1 size-3.5" />
          New column
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto px-6 pb-6">
        <div className="flex h-full items-stretch gap-4">
          {board.columns.map((col, i) => (
            <BoardColumnView
              key={col.id}
              column={col}
              columns={board.columns}
              tasks={grid[i]}
              projectNames={projectNames}
              workspaces={allWorkspaces}
              sessions={sessionByWorkspace}
              prs={prByWorkspace}
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
              onFocus={setFocusedId}
              onStartTask={onStartTask}
              onOpenSession={onOpenSession}
            />
          ))}
        </div>
      </div>

      {dialog && (
        <TaskDialog
          state={dialog}
          projects={projects}
          onClose={() => setDialog(null)}
        />
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
  columns,
  tasks,
  projectNames,
  workspaces,
  sessions,
  prs,
  dragTaskId,
  dropSpot,
  focusedId,
  onDragStateChange,
  onMoveTask,
  onEdit,
  onAdd,
  onFocus,
  onStartTask,
  onOpenSession,
}: {
  column: BoardColumn;
  columns: BoardColumn[];
  tasks: Task[];
  projectNames: Map<string, string>;
  workspaces: Map<string, Workspace>;
  sessions: Record<string, SessionPayload>;
  prs: Record<string, PrPayload>;
  dragTaskId: string | null;
  dropSpot: DropSpot | null;
  focusedId: string | null;
  onDragStateChange: (taskId?: string | null, spot?: DropSpot | null) => void;
  onMoveTask: (taskId: string, columnId: string, position: number) => void;
  onEdit: (t: Task) => void;
  onAdd: () => void;
  onFocus: (id: string) => void;
  onStartTask: (t: Task) => void;
  onOpenSession: (workspaceId: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(column.name);
  const listRef = useRef<HTMLDivElement>(null);

  const submitRename = () => {
    setRenaming(false);
    const name = nameDraft.trim();
    if (name && name !== column.name)
      columnUpdate(column.id, { name }).catch((e) =>
        toast.error("Could not rename column", { description: String(e) }),
      );
  };

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
      <div
        className="group flex items-center gap-2 px-3 py-2.5"
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData("bl/column", column.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          // Column reorder: drop a column header onto another header.
          if (e.dataTransfer.types.includes("bl/column")) e.preventDefault();
        }}
        onDrop={(e) => {
          const dragged = e.dataTransfer.getData("bl/column");
          if (!dragged || dragged === column.id) return;
          e.preventDefault();
          e.stopPropagation();
          const i = columns.findIndex((c) => c.id === column.id);
          const prev = columns[i - 1];
          const position = prev
            ? (prev.position + column.position) / 2
            : column.position / 2;
          columnMove(dragged, position).catch(() => {});
        }}
      >
        <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
        {renaming ? (
          <Input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            className="h-6 px-1.5 text-sm"
          />
        ) : (
          <button
            className="min-w-0 flex-1 truncate text-left text-sm font-medium"
            onDoubleClick={() => {
              setNameDraft(column.name);
              setRenaming(true);
            }}
          >
            {column.name}
          </button>
        )}
        {column.role !== "none" && (
          <span
            className="text-[10px] uppercase tracking-wide text-muted-foreground/60"
            title={
              column.role === "active"
                ? "Cards land here when their session starts"
                : "Cards land here when their PR merges or the workspace is deleted"
            }
          >
            {column.role}
          </span>
        )}
        <Badge
          variant="secondary"
          className="h-5 min-w-5 justify-center px-1 text-[11px]"
        >
          {tasks.length}
        </Badge>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {
                setNameDraft(column.name);
                setRenaming(true);
              }}
            >
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={column.role === "active"}
              onClick={() => void columnUpdate(column.id, { role: "active" })}
            >
              Set as Active (sessions land here)
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={column.role === "done"}
              onClick={() => void columnUpdate(column.id, { role: "done" })}
            >
              Set as Done (merged/deleted land here)
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={column.role === "none"}
              onClick={() => void columnUpdate(column.id, { role: "none" })}
            >
              Clear role
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={tasks.length > 0}
              onClick={() =>
                columnDelete(column.id).catch((e) =>
                  toast.error("Could not delete column", {
                    description: String(e),
                  }),
                )
              }
            >
              Delete column
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
              dragging={dragTaskId === task.id}
              focused={focusedId === task.id}
              onDragStateChange={onDragStateChange}
              onFocus={onFocus}
              onEdit={onEdit}
              onStartTask={onStartTask}
              onOpenSession={onOpenSession}
            />
          </div>
        ))}
        {dropSpot && dropSpot.before === null && <DropLine />}

        {/* Hover affordance: appears under the last card, outlines on its own
            hover, and opens the create dialog (title pre-focused). */}
        <button
          onClick={onAdd}
          className="mx-auto mt-1 flex items-center gap-1 rounded-md border border-transparent px-3 py-1.5 text-xs text-muted-foreground opacity-0 transition-all hover:border-border hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/column:opacity-100"
        >
          <Plus className="size-3.5" />
          Add task
        </button>
      </div>
    </div>
  );
}

/** Minimal live status for a card's linked session. */
function sessionStatus(
  workspace: Workspace | undefined,
  session: SessionPayload | undefined,
  pr: PrPayload | undefined,
): { label: string; spin?: boolean; className: string } | null {
  if (!workspace) return null;
  if (workspace.setup === "provisioning")
    return { label: "setting up", spin: true, className: "text-muted-foreground" };
  if (workspace.setup === "failed")
    return { label: "setup failed", className: "text-destructive" };
  if (session?.activity === "working")
    return { label: "working", spin: true, className: "text-primary" };
  if (session?.awaitingInput || session?.needsAttention)
    return { label: "needs you", className: "text-warning" };
  if (pr?.status?.state === "OPEN")
    return {
      label: pr.status.rollup === "pending" ? "checks running" : "in review",
      className: "text-muted-foreground",
    };
  return { label: "idle", className: "text-muted-foreground" };
}

function TaskCard({
  task,
  projectName,
  workspace,
  session,
  pr,
  dragging,
  focused,
  onDragStateChange,
  onFocus,
  onEdit,
  onStartTask,
  onOpenSession,
}: {
  task: Task;
  projectName?: string;
  workspace?: Workspace;
  session?: SessionPayload;
  pr?: PrPayload;
  dragging: boolean;
  focused: boolean;
  onDragStateChange: (taskId?: string | null, spot?: DropSpot | null) => void;
  onFocus: (id: string) => void;
  onEdit: (t: Task) => void;
  onStartTask: (t: Task) => void;
  onOpenSession: (workspaceId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  const status = sessionStatus(workspace, session, pr);

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
        onEdit(task);
      }}
      className={cn(
        "group/card cursor-pointer rounded-md border bg-card px-3 py-2.5 shadow-sm transition-opacity hover:bg-accent/40",
        focused ? "border-primary/60 ring-1 ring-primary/40" : "border-border hover:border-border/80",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 text-sm leading-snug">{task.title}</div>
        {!task.workspaceId && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStartTask(task);
            }}
            title="Start a session for this task"
            className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/card:opacity-100"
          >
            <Play className="size-3.5" />
          </button>
        )}
      </div>
      {(projectName || workspace || status) && (
        <div className="mt-2 flex items-center gap-1.5">
          {projectName && (
            <Badge
              variant="secondary"
              className="max-w-36 truncate px-1.5 text-[10px]"
            >
              {projectName}
            </Badge>
          )}
          {workspace && status && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenSession(workspace.id);
              }}
              className={cn(
                "flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent",
                status.className,
              )}
              title="Open the linked session"
            >
              {status.spin ? (
                <Loader2 className="size-2.5 animate-spin" />
              ) : (
                <MessageSquare className="size-2.5" />
              )}
              {status.label}
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent>
        {!task.workspaceId && (
          <ContextMenuItem onClick={() => onStartTask(task)}>
            <Play className="mr-2 size-3.5" />
            Start session
          </ContextMenuItem>
        )}
        {workspace && (
          <ContextMenuItem onClick={() => onOpenSession(workspace.id)}>
            <MessageSquare className="mr-2 size-3.5" />
            Open session
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

/** Create + edit dialog. Settings-dialog sized — the space grows into
 *  richer task detail over time. */
function TaskDialog({
  state,
  projects,
  onClose,
}: {
  state: DialogState;
  projects: ProjectView[];
  onClose: () => void;
}) {
  const task = state.mode === "edit" ? state.task : null;
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [projectId, setProjectId] = useState(task?.projectId ?? "");
  // GitHub import (create mode): open issues of the selected project's repo.
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [loadingIssues, setLoadingIssues] = useState(false);

  const importIssues = () => {
    if (!projectId) return;
    setLoadingIssues(true);
    listProjectIssues(projectId)
      .then(setIssues)
      .catch((e) =>
        toast.error("Could not load GitHub issues", { description: String(e) }),
      )
      .finally(() => setLoadingIssues(false));
  };

  const applyIssue = (issue: IssueSummary) => {
    setTitle(issue.title);
    setDescription(
      [`GitHub issue #${issue.number} by ${issue.author}`, issue.url, "", issue.body ?? ""]
        .join("\n")
        .trim(),
    );
    setIssues(null);
  };

  const save = () => {
    if (!title.trim()) return;
    const done =
      state.mode === "edit"
        ? taskUpdate(state.task.id, {
            title: title.trim(),
            description,
            projectId,
          })
        : taskCreate(title.trim(), {
            description: description || undefined,
            projectId: projectId || undefined,
            columnId: state.columnId,
          });
    done
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
            {state.mode === "edit" ? "Edit task" : "New task"}
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
            {state.mode === "create" && (
              <Button
                variant="outline"
                size="sm"
                disabled={!projectId || loadingIssues}
                onClick={importIssues}
                title={
                  projectId
                    ? "Fill this task from an open GitHub issue"
                    : "Select a project first"
                }
              >
                {loadingIssues ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <CloudDownload className="mr-1.5 size-3.5" />
                )}
                Import from GitHub
              </Button>
            )}
          </div>
          {issues && (
            <div className="max-h-48 overflow-y-auto rounded-md border border-border">
              {issues.length === 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No open issues in this repo.
                </div>
              )}
              {issues.map((issue) => (
                <button
                  key={issue.number}
                  onClick={() => applyIssue(issue)}
                  className="flex w-full items-baseline gap-2 border-b border-border/50 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent"
                >
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    #{issue.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {issue.author}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col">
            <Field label="Description" className="flex min-h-0 flex-1 flex-col">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional — included in the session prompt."
                className="min-h-0 flex-1 resize-none text-sm"
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!title.trim()}>
              {state.mode === "edit" ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
