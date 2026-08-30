// The "new task" dialog. Linear-style: borderless title/description, a chip
// per property (each with a single-key shortcut), ⌘↵ to submit, and a
// "Create more" toggle for rapid entry. Editing opens TaskEditDialog.
import { useRef, useState } from "react";
import { CloudDownload, Loader2, Lock, PanelTop, Triangle } from "lucide-react";
import { toast } from "sonner";
import { listProjectIssues, taskCreate, taskUpdate } from "../../lib/api";
import {
  byNumber,
  estimateLabel,
  roleToState,
  type BoardCtx,
} from "../../lib/board";
import type {
  BoardColumn,
  EstimateUnit,
  IssueSummary,
  ProjectView,
} from "../../lib/types";
import { StateIcon } from "./TaskCard";
import {
  ColumnPicker,
  CreateChip,
  DepPickerContent,
  EstimatePicker,
  InlineEstimateInput,
  PickerContent,
  ProjectPicker,
  type PickerId,
} from "./pickers";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";

/** The board's create-dialog state — also one arm of its `DialogState`. */
export interface CreateState {
  mode: "create";
  columnId: string;
  parentId?: string | null;
}

export function TaskCreateDialog({
  state,
  projects,
  ctx,
  columns,
  boardUnit,
  onClose,
}: {
  state: CreateState;
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
