// "My work" — a lightweight kanban board over the backend TaskStore
// (src-tauri/src/tasks.rs). Local state seeds from `boardSnapshot()` and every
// mutation comes back authoritatively via the `tasks:changed` event; drags
// apply optimistically in between. Ordering uses fractional positions — the
// frontend computes midpoints, the backend renumbers when gaps exhaust.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleDot,
  GripVertical,
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
  taskCreate,
  taskDelete,
  taskMove,
  taskUpdate,
} from "../../lib/api";
import { onTasksChanged } from "../../lib/events";
import type {
  BoardColumn,
  BoardSnapshot,
  ProjectView,
  Task,
  Workspace,
} from "../../lib/types";
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
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const [editing, setEditing] = useState<Task | null>(null);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropColumn, setDropColumn] = useState<string | null>(null);

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
    () =>
      projects.filter((p) => board.tasks.some((t) => t.projectId === p.id)),
    [projects, board.tasks],
  );
  const visibleTasks = useMemo(
    () =>
      projectFilter
        ? board.tasks.filter((t) => t.projectId === projectFilter)
        : board.tasks,
    [board.tasks, projectFilter],
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

      <div className="flex-1 overflow-x-auto px-6 pb-6">
        <div className="flex h-full items-start gap-4">
          {board.columns.map((col) => (
            <BoardColumnView
              key={col.id}
              column={col}
              columns={board.columns}
              tasks={visibleTasks.filter((t) => t.columnId === col.id)}
              projectNames={projectNames}
              workspaces={allWorkspaces}
              dragTaskId={dragTaskId}
              isDropTarget={dropColumn === col.id}
              onDragStateChange={(taskId, over) => {
                if (taskId !== undefined) setDragTaskId(taskId);
                if (over !== undefined) setDropColumn(over);
              }}
              onMoveTask={moveTask}
              onEdit={setEditing}
              onStartTask={onStartTask}
              onOpenSession={onOpenSession}
            />
          ))}
        </div>
      </div>

      {editing && (
        <EditTaskDialog
          task={editing}
          projects={projects}
          onClose={() => setEditing(null)}
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

function BoardColumnView({
  column,
  columns,
  tasks,
  projectNames,
  workspaces,
  dragTaskId,
  isDropTarget,
  onDragStateChange,
  onMoveTask,
  onEdit,
  onStartTask,
  onOpenSession,
}: {
  column: BoardColumn;
  columns: BoardColumn[];
  tasks: Task[];
  projectNames: Map<string, string>;
  workspaces: Map<string, Workspace>;
  dragTaskId: string | null;
  isDropTarget: boolean;
  onDragStateChange: (taskId?: string | null, over?: string | null) => void;
  onMoveTask: (taskId: string, columnId: string, position: number) => void;
  onEdit: (t: Task) => void;
  onStartTask: (t: Task) => void;
  onOpenSession: (workspaceId: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(column.name);
  const [quickAdd, setQuickAdd] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const submitRename = () => {
    setRenaming(false);
    const name = nameDraft.trim();
    if (name && name !== column.name)
      columnUpdate(column.id, { name }).catch((e) =>
        toast.error("Could not rename column", { description: String(e) }),
      );
  };

  const submitQuickAdd = () => {
    const title = quickAdd.trim();
    if (!title) return;
    setQuickAdd("");
    taskCreate(title, { columnId: column.id }).catch((e) =>
      toast.error("Could not add task", { description: String(e) }),
    );
  };

  /** Which card the pointer is above (drop inserts before it). */
  const dropTargetFor = (clientY: number): Task | null => {
    const cards = listRef.current?.querySelectorAll<HTMLElement>("[data-task-id]");
    for (const el of cards ?? []) {
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
        "flex max-h-full w-[280px] shrink-0 flex-col rounded-lg border bg-card/50",
        isDropTarget ? "border-primary/50 ring-1 ring-primary/30" : "border-border",
      )}
      onDragOver={(e) => {
        if (!dragTaskId) return;
        e.preventDefault();
        onDragStateChange(undefined, column.id);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        onDragStateChange(undefined, null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const taskId = e.dataTransfer.getData("text/plain") || dragTaskId;
        onDragStateChange(null, null);
        if (!taskId) return;
        const before = dropTargetFor(e.clientY);
        if (before?.id === taskId) return;
        onMoveTask(
          taskId,
          column.id,
          positionBefore(tasks.filter((t) => t.id !== taskId), before),
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
        <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1 text-[11px]">
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

      <div ref={listRef} className="flex flex-col gap-2 overflow-y-auto px-2 pb-2">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            projectName={task.projectId ? projectNames.get(task.projectId) : undefined}
            workspace={task.workspaceId ? workspaces.get(task.workspaceId) : undefined}
            dragging={dragTaskId === task.id}
            onDragStateChange={onDragStateChange}
            onEdit={onEdit}
            onStartTask={onStartTask}
            onOpenSession={onOpenSession}
          />
        ))}
      </div>

      <div className="p-2 pt-0">
        <Input
          value={quickAdd}
          onChange={(e) => setQuickAdd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitQuickAdd()}
          placeholder="Add a task…"
          className="h-8 border-dashed bg-transparent text-sm"
        />
      </div>
    </div>
  );
}

function TaskCard({
  task,
  projectName,
  workspace,
  dragging,
  onDragStateChange,
  onEdit,
  onStartTask,
  onOpenSession,
}: {
  task: Task;
  projectName?: string;
  workspace?: Workspace;
  dragging: boolean;
  onDragStateChange: (taskId?: string | null, over?: string | null) => void;
  onEdit: (t: Task) => void;
  onStartTask: (t: Task) => void;
  onOpenSession: (workspaceId: string) => void;
}) {
  const card = (
    <div
      data-task-id={task.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStateChange(task.id, undefined);
      }}
      onDragEnd={() => onDragStateChange(null, null)}
      onClick={() => onEdit(task)}
      className={cn(
        "cursor-pointer rounded-md border border-border bg-card px-3 py-2.5 shadow-sm transition-opacity hover:border-border/80 hover:bg-accent/40",
        dragging && "opacity-40",
      )}
    >
      <div className="text-sm leading-snug">{task.title}</div>
      {(projectName || workspace) && (
        <div className="mt-2 flex items-center gap-1.5">
          {projectName && (
            <Badge variant="secondary" className="max-w-36 truncate px-1.5 text-[10px]">
              {projectName}
            </Badge>
          )}
          {workspace && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenSession(workspace.id);
              }}
              className="flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Open the linked session"
            >
              <MessageSquare className="size-2.5" />
              session
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

function EditTaskDialog({
  task,
  projects,
  onClose,
}: {
  task: Task;
  projects: ProjectView[];
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [projectId, setProjectId] = useState(task.projectId ?? "");

  const save = () => {
    if (!title.trim()) return;
    taskUpdate(task.id, {
      title: title.trim(),
      description,
      projectId,
    })
      .then(onClose)
      .catch((e) =>
        toast.error("Could not save task", { description: String(e) }),
      );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Edit task</DialogTitle>
        <div className="flex flex-col gap-4">
          <Field label="Title">
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional — included in the session prompt."
              className="min-h-[80px] text-sm"
            />
          </Field>
          <Field label="Project">
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="">No project (starts a quick chat)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!title.trim()}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
