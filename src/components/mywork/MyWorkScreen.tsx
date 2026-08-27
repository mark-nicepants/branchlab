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
  Clock,
  CloudDownload,
  Loader2,
  MessageSquare,
  Play,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import {
  boardSnapshot,
  chatArchive,
  listProjectIssues,
  taskCreate,
  taskDelete,
  taskMove,
  taskUpdate,
} from "../../lib/api";
import { onTasksChanged } from "../../lib/events";
import type {
  BoardColumn,
  Entry,
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
import { TaskRef } from "./TaskRef";
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
  const { sessionByWorkspace, prByWorkspace } = useWorkspaceData();

  // Arriving from a session's task chip: focus + reveal that card.
  useEffect(() => {
    if (!focusTaskId) return;
    setFocusedId(focusTaskId);
    onFocusTaskHandled();
  }, [focusTaskId, onFocusTaskHandled]);

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
  // Filter chips: only projects that actually have cards.
  const filterProjects = useMemo(
    () => projects.filter((p) => board.tasks.some((t) => t.projectId === p.id)),
    [projects, board.tasks],
  );
  const visibleTasks = useMemo(
    () =>
      board.tasks.filter(
        (t) =>
          // Subtasks (v2) render in their parent's drill-down, never here.
          t.parentId === null &&
          (projectFilter === null || t.projectId === projectFilter),
      ),
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
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto px-6 pb-6">
        <div className="flex h-full items-stretch gap-4">
          {board.columns.map((col, i) => (
            <BoardColumnView
              key={col.id}
              column={col}
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
              onOpenArchive={setArchiveFor}
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
  onOpenArchive,
}: {
  column: BoardColumn;
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
              onOpenArchive={onOpenArchive}
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
  columnRole,
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
  onOpenArchive,
}: {
  task: Task;
  columnRole: BoardColumn["role"];
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
  onOpenArchive: (t: Task) => void;
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
        <div className="min-w-0 flex-1 text-sm leading-snug">
          <TaskRef number={task.number} className="mr-1.5 align-middle" />
          {task.title}
        </div>
      </div>
      {(projectName || task.workspaceId || columnRole === "active") && (
        <div className="mt-2 flex items-center gap-1.5">
          {columnRole === "active" && !task.workspaceId && (
            <span
              className="flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
              title="Waiting for an agent slot — picked up automatically"
            >
              <Clock className="size-2.5" />
              queued
            </span>
          )}
          {projectName && (
            <Badge
              variant="secondary"
              className="max-w-36 truncate px-1.5 text-[10px]"
            >
              {projectName}
            </Badge>
          )}
          {task.workspaceId && !workspace && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenArchive(task);
              }}
              className="flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title="The workspace is gone; open the archived conversation"
            >
              <MessageSquare className="size-2.5" />
              chat archive
            </button>
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
        {!workspace && (
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
  // GitHub import (create mode): a searchable dropdown of the repo's open
  // issues (already sorted newest-updated first by the backend).
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [loadingIssues, setLoadingIssues] = useState(false);

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
    setIssuesOpen(false);
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
            {state.mode === "edit" ? `Task #${state.task.number}` : "New task"}
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
            )}
          </div>
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
              {state.mode === "edit" ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
