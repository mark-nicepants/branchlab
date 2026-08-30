// The task view: a main column (title, markdown description, attachments,
// subtasks, activity feed) plus a Linear-style properties rail where every
// row has a key. Every field commits independently — the board re-feeds the
// task from each `tasks:changed` snapshot, so nothing is buffered here.
import { useRef, useState } from "react";
import {
  Lock,
  MessageSquare,
  PanelTop,
  Paperclip,
  Pencil,
  Play,
  Triangle,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  taskAttachData,
  taskAttachPath,
  taskAttachmentPath,
  taskAttachmentRemove,
  taskMove,
  taskUpdate,
} from "../../lib/api";
import {
  byNumber,
  depCandidates,
  deriveState,
  estimateLabel,
  positionAtEnd,
  type BoardCtx,
} from "../../lib/board";
import type {
  BoardColumn,
  DiffStat,
  EstimateUnit,
  PrPayload,
  ProjectView,
  SessionPayload,
  Task,
  TaskAttachment,
  Workspace,
} from "../../lib/types";
import { StateIcon, StatusChip } from "./TaskCard";
import { ActivityFeed } from "./ActivityFeed";
import { ArchiveDialog } from "./ArchiveDialog";
import { SubtasksSection } from "./SubtasksSection";
import {
  ColumnPicker,
  DepEditChip,
  DepPickerContent,
  EstimatePicker,
  InlineEstimateInput,
  PickerContent,
  ProjectPicker,
  RailRow,
  type PickerId,
} from "./pickers";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { fileToDataUrl } from "@/hooks/useClipboardImages";
import { cn } from "@/lib/utils";

export function TaskEditDialog({
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
  const [attachHot, setAttachHot] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<{ focusSlash: () => void } | null>(null);

  const fail = (e: unknown) =>
    toast.error("Could not save task", { description: String(e) });

  /** HTML5-dropped files go up as base64 — WKWebView drops carry no path. */
  const attachDroppedFiles = (files: FileList) => {
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.error("attachments are capped at 25MB", {
          description: file.name,
        });
        continue;
      }
      void fileToBase64(file)
        .then((data) => taskAttachData(task.id, file.name, data))
        .catch((e) =>
          toast.error("Could not attach file", { description: String(e) }),
        );
    }
  };

  /** The Attach button: native multi-file picker → attach by path. */
  const pickAttachments = async () => {
    try {
      const paths = await openFileDialog({ multiple: true });
      if (!paths) return;
      for (const p of Array.isArray(paths) ? paths : [paths]) {
        await taskAttachPath(task.id, p);
      }
    } catch (e) {
      toast.error("Could not attach file", { description: String(e) });
    }
  };

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
    const end = positionAtEnd(ctx.taskById.values(), columnId);
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

          {/* Attachment drop target: scoped to the description+attachments
              area (not the whole dialog) so it can never fight the intake
              panel's own file-drop zone in SubtasksSection below. */}
          <div
            className={cn(
              "-m-2 flex flex-col gap-5 rounded-lg p-2 transition-colors",
              attachHot && "bg-primary/5 ring-1 ring-inset ring-primary/40",
            )}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setAttachHot(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setAttachHot(false);
            }}
            onDrop={(e) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setAttachHot(false);
              attachDroppedFiles(e.dataTransfer.files);
            }}
          >
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

            <AttachmentsSection
              task={task}
              onPick={() => void pickAttachments()}
            />
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

// ── Attachments (edit dialog only) ──

/** Matches the backend cap in tasks::add_attachment. */
const MAX_ATTACHMENT_BYTES = 25_000_000;

/** "48 KB" / "1.2 MB" — compact attachment size. */
function fmtSize(bytes: number): string {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/** Chunk-safe base64 of a File: readAsDataURL then strip the data: prefix
 *  (avoids building huge strings from Uint8Array one char at a time). */
function fileToBase64(file: File): Promise<string> {
  return fileToDataUrl(file).then((url) => url.slice(url.indexOf(",") + 1));
}

/** Attachment chip list + the Attach affordance. Clicking a chip opens the
 *  stored file with the system default app; the hover × removes it (no
 *  confirm — the feed records it, so nothing is silently lost). */
function AttachmentsSection({
  task,
  onPick,
}: {
  task: Task;
  onPick: () => void;
}) {
  const openAttachment = async (att: TaskAttachment) => {
    try {
      const path = await taskAttachmentPath(task.id, att.id);
      // Same lazy-import pattern as lib/links.ts openExternal.
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(path);
    } catch (e) {
      toast.error("Could not open attachment", { description: String(e) });
    }
  };
  const remove = (att: TaskAttachment) =>
    taskAttachmentRemove(task.id, att.id).catch((e) =>
      toast.error("Could not remove attachment", { description: String(e) }),
    );

  return (
    <div className="flex flex-col gap-1.5">
      {task.attachments.length > 0 && (
        <span className="text-xs font-medium tracking-wide text-muted-foreground">
          ATTACHMENTS
        </span>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {task.attachments.map((att) => (
          <button
            key={att.id}
            onClick={() => void openAttachment(att)}
            title={`Open ${att.name}`}
            className="group/att flex max-w-full items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent/50"
          >
            <Paperclip className="size-3 shrink-0 text-muted-foreground" />
            <span className="max-w-[40ch] truncate">{att.name}</span>
            <span className="shrink-0 text-[10.5px] text-muted-foreground">
              {fmtSize(att.size)}
            </span>
            {/* span, not button: chips are buttons and can't nest one. */}
            <span
              onClick={(e) => {
                e.stopPropagation();
                void remove(att);
              }}
              title="Remove attachment"
              className="shrink-0 rounded-full text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/att:opacity-100"
            >
              <X className="size-3" />
            </span>
          </button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={onPick}
          title="Attach files — or drop them on this area"
          className="gap-1.5 px-2 text-muted-foreground hover:text-foreground"
        >
          <Paperclip className="size-3.5" />
          Attach
        </Button>
      </div>
    </div>
  );
}
