// The edit dialog's subtask list: rows with live status, the rapid-add
// input (Enter keeps adding, a pasted list splits per line), AI "Suggest
// plan" ordering/estimating, and the "Split with AI" intake panel.
import { useState } from "react";
import { Loader2, Scissors, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { taskCreate, taskIntake, taskSuggestPlan } from "../../lib/api";
import {
  byNumber,
  deriveState,
  firstUnmetDep,
  type BoardCtx,
} from "../../lib/board";
import { formatEstimate } from "../../lib/types";
import type {
  EstimateUnit,
  PrPayload,
  SessionPayload,
  Task,
  Workspace,
} from "../../lib/types";
import {
  DepChip,
  SEG_COLOR,
  SEG_ORDER,
  StateIcon,
  StatusChip,
} from "./TaskCard";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Subtask list + AI "Suggest plan" + rapid add input. */
export function SubtasksSection({
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
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intake, setIntake] = useState("");
  const [splitting, setSplitting] = useState(false);
  const [dropHot, setDropHot] = useState(false);

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
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIntakeOpen((o) => !o)}
          title="Paste raw content (email, notes, spreadsheet rows) and let AI split it into subtasks"
        >
          <Scissors className="mr-1.5 size-3.5" />
          Split with AI
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

      {intakeOpen && (
        <div
          className={cn(
            "mt-1 flex flex-col gap-2 rounded-lg border p-3",
            dropHot ? "border-primary ring-1 ring-primary/40" : "border-border",
          )}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDropHot(true);
          }}
          onDragLeave={() => setDropHot(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDropHot(false);
            for (const file of Array.from(e.dataTransfer.files)) {
              if (
                file.size > 1_000_000 ||
                /\.(xlsx?|docx|pdf)$/i.test(file.name)
              ) {
                toast.error(
                  "Drop a text file — or paste the cells/text directly",
                );
                continue;
              }
              void file.text().then((text) =>
                setIntake((cur) => (cur ? `${cur}\n\n${text}` : text)),
              );
            }
          }}
        >
          <Textarea
            autoFocus
            value={intake}
            disabled={splitting}
            onChange={(e) => setIntake(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setIntakeOpen(false);
              }
            }}
            placeholder="Paste anything — a client email, meeting notes, Excel rows — or drop a text file here…"
            className="min-h-28 resize-y border-0 p-0 shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[11px] text-muted-foreground">
              AI splits this into subtasks with estimates and ordering
            </span>
            <Button
              size="sm"
              disabled={splitting || !intake.trim()}
              onClick={() => {
                setSplitting(true);
                taskIntake(task.id, intake)
                  .then(({ updated, notes }) => {
                    toast.success(`Created ${updated} subtasks`, {
                      description: notes ?? undefined,
                    });
                    setIntake("");
                    setIntakeOpen(false);
                  })
                  .catch((e) =>
                    toast.error("Could not split that", {
                      description: String(e),
                    }),
                  )
                  .finally(() => setSplitting(false));
              }}
            >
              {splitting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Split into subtasks
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
