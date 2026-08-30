// One board card + the small status primitives it shares with the dialogs:
// the GitHub-Projects-style state glyph, the live status/PR/dep chips, and a
// parent card's segmented subtask bar.
import { useEffect, useRef } from "react";
import {
  CircleDot,
  Clock,
  GitPullRequest,
  Loader2,
  Lock,
  MessageSquare,
  Play,
} from "lucide-react";
import { toast } from "sonner";
import { taskDelete } from "../../lib/api";
import {
  deriveState,
  firstUnmetDep,
  type BoardCtx,
  type CardState,
} from "../../lib/board";
import type {
  ColumnRole,
  DiffStat,
  PrPayload,
  PrStatus,
  SessionPayload,
  Task,
  Workspace,
} from "../../lib/types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

/** Where a dragged card would land: before `before`, or at the end (null). */
export interface DropSpot {
  columnId: string;
  before: string | null;
}

// GitHub's PR/review purple has no theme token — a deliberate one-off.
export const REVIEW_TEXT = "text-[#a371f7]";
export const REVIEW_BORDER = "border-[#a371f7]/45";

/** Shared pill styling for the tiny status/PR/dep chips. */
export const CHIP =
  "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]";

/** 13px GitHub-style state glyph (open / clock / dot / check circle). */
export function StateIcon({
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

/** The header-right live-status chip. Clicking it opens the linked session
 *  when one exists (the old session-chip behavior). */
export function StatusChip({
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
export function PrChip({ status }: { status: PrStatus }) {
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
export function DepChip({ number }: { number: number }) {
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
export const SEG_ORDER: Record<CardState, number> = {
  done: 0,
  review: 1,
  working: 2,
  queued: 3,
  todo: 3,
};
export const SEG_COLOR: Record<CardState, string> = {
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

export function TaskCard({
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
