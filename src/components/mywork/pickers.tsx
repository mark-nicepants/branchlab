// Shared pickers + rail/chip primitives for the "My work" dialogs — the
// edit dialog's properties rail and the create dialog's chip row drive the
// same popover bodies, so they live here rather than in either dialog.
import { useRef, useState } from "react";
import { CircleCheck, X } from "lucide-react";
import { roleToState } from "../../lib/board";
import { TSHIRT_SIZES } from "../../lib/types";
import type {
  BoardColumn,
  EstimateUnit,
  ProjectView,
  Task,
} from "../../lib/types";
import { CHIP, StateIcon } from "./TaskCard";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { PopoverContent } from "@/components/ui/popover";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/** Which picker popover is open (create-dialog chips + edit-dialog rail). */
export type PickerId =
  | "status"
  | "project"
  | "estimate"
  | "blockedBy"
  | "blocks"
  | "import";

/** Picker popover chrome: Radix would focus the content wrapper, leaving
 *  cmdk deaf to arrow keys — land focus on the search input (or the command
 *  root for list-only pickers) so keyboard-opened pickers work immediately. */
export function PickerContent({
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
export function InlineEstimateInput({
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

/** One properties-rail row: icon + value + right-aligned key hint. */
export function RailRow({
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
export function CreateChip({
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

/** Column list picker (the status/column property). */
export function ColumnPicker({
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
export function ProjectPicker({
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
export function EstimatePicker({ onSelect }: { onSelect: (value: number) => void }) {
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
export function DepEditChip({ task, onRemove }: { task: Task; onRemove: () => void }) {
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
export function DepPickerContent({
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
