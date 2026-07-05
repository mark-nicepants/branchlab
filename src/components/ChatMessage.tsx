import { parseTypedDisplay, type TypedDisplay } from "@/lib/chatDisplay";
import { parseDiff, synthesizeDiff } from "@/lib/diff";
import { fileName } from "@/lib/review";
import { cn } from "@/lib/utils";
import {
  Bot,
  ChevronRight,
  FileText,
  Globe,
  Loader2,
  Lock,
  MessageSquare,
  MoveRight,
  Pencil,
  Search,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AssistantEntry,
  Block,
  ChatPermissionEvent,
  DiffBlock,
  SystemEntry,
  ToolBlock,
  UserEntry,
} from "../lib/types";
import { UnifiedDiff } from "./DiffBody";
import { Button } from "@/components/ui/button";
import { usePreferences, type ChatDensity } from "./PreferencesProvider";

// ── Message base ──────────────────────────────────────────────────────────
//
// Every transcript entry renders inside a `MessageShell` (side, width, and
// density spacing — the one thing all message types share), then picks its
// chrome: the classic user bubble, a structured `SectionCard`, or bare
// content (assistant prose). New typed messages compose these primitives so
// user / assistant / system variants stay coherent.

/** Single source of truth for vertical spacing, keyed by chat density. */
const DENSITY: Record<
  ChatDensity,
  { assistant: string; userMargin: string; userPad: string; gap: string }
> = {
  tight: {
    assistant: "py-1",
    userMargin: "my-1",
    userPad: "py-2",
    gap: "gap-2",
  },
  loose: {
    assistant: "py-3",
    userMargin: "my-3",
    userPad: "py-2.5",
    gap: "gap-6",
  },
  roomy: {
    assistant: "py-5",
    userMargin: "my-5",
    userPad: "py-3",
    gap: "gap-10",
  },
};

interface ShellProps {
  role: "user" | "assistant" | "system";
  /** "bubble" = classic user bubble; "none" = the child brings its own chrome
   *  (cards) or renders bare (assistant prose). */
  chrome?: "bubble" | "none";
  children: React.ReactNode;
}

export function MessageShell({ role, chrome = "none", children }: ShellProps) {
  const { prefs } = usePreferences();
  const d = DENSITY[prefs.chatDensity] ?? DENSITY.loose;
  const isUser = role === "user";
  return (
    <div
      className={cn(
        "flex w-full",
        // Three lanes: user right, agent left, system center — the author is
        // readable from silhouette alone.
        isUser
          ? "justify-end"
          : role === "system"
            ? "justify-center"
            : "justify-start",
      )}
    >
      <div
        className={cn(
          "flex flex-col select-text text-sm",
          d.gap,
          // Both participant lanes cap at 80% of the column, so the agent's
          // answer reads as "from the agent" rather than page furniture.
          isUser &&
            cn("max-w-[80%]", chrome === "none" && "w-full", d.userMargin),
          role === "assistant" && cn("w-full max-w-[80%]", d.assistant),
          role === "system" && d.assistant,
          // The user bubble is the shared surface, one tint step up, with the
          // top-right corner sharpened (speech direction).
          chrome === "bubble" &&
            cn(
              "self-end rounded-2xl rounded-tr-sm border border-border bg-secondary px-4",
              d.userPad,
            ),
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** The one structured-message surface: header band, row body, optional muted
 *  footer — a hairline between each. The work section and typed user cards
 *  (review feedback) both derive from this, so they read as one component.
 *  Pass `onHeaderClick` to make the header a disclosure toggle. */
function SectionCard({
  header,
  onHeaderClick,
  footer,
  children,
}: {
  header: React.ReactNode;
  onHeaderClick?: () => void;
  footer?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const headerClass =
    "flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground";
  return (
    <div className="w-full min-w-0 overflow-hidden rounded-xl border border-border bg-card text-sm">
      {onHeaderClick ? (
        <button
          onClick={onHeaderClick}
          className={cn(headerClass, "hover:text-foreground")}
        >
          {header}
        </button>
      ) : (
        <div className={headerClass}>{header}</div>
      )}
      {children && (
        <div className="border-t border-border px-1.5 pb-1.5 pt-1">
          {children}
        </div>
      )}
      {footer && (
        <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  );
}

// ── User messages ─────────────────────────────────────────────────────────

/** One user entry: typed payloads get their dedicated renderer, everything
 *  else renders as the classic bubble (text + image attachments). */
export function UserMessageView({ entry }: { entry: UserEntry }) {
  const typed = parseTypedDisplay(entry.display);
  if (typed?.$kind === "review") {
    return (
      <MessageShell role="user">
        <ReviewFeedbackMessage payload={typed} />
      </MessageShell>
    );
  }
  return (
    <MessageShell role="user" chrome="bubble">
      {entry.display && (
        <div className="whitespace-pre-wrap">
          {entry.origin !== "user" && (
            <span className="mr-2 inline-block rounded border border-border px-1.5 align-[2px] text-[9px] uppercase tracking-wider text-muted-foreground">
              {entry.origin}
            </span>
          )}
          {entry.display}
        </div>
      )}
      {entry.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {entry.attachments.map((a, i) => (
            <img
              key={i}
              src={a.url}
              alt={a.filename ?? "image"}
              className="size-16 rounded border border-border object-cover"
            />
          ))}
        </div>
      )}
    </MessageShell>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Batched inline review comments, sent from the Changes panel. Same card as
 *  the work section; each comment mimics a tool-call step row. */
function ReviewFeedbackMessage({ payload }: { payload: TypedDisplay }) {
  const files = new Set(payload.comments.map((c) => c.file)).size;
  return (
    <SectionCard
      header={
        <>
          <MessageSquare className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">Review feedback</span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] tabular-nums">
            {plural(payload.comments.length, "comment")} ·{" "}
            {plural(files, "file")}
          </span>
        </>
      }
      footer="The agent receives each comment with its file, line number, and the exact line content."
    >
      {payload.comments.map((c, i) => (
        <div
          key={i}
          className="flex items-baseline gap-2 rounded-lg px-2 py-1 text-xs"
        >
          <span
            className="shrink-0 font-mono text-[11px] text-primary"
            title={c.file}
          >
            {fileName(c.file)}:{c.line}
          </span>
          <span className="min-w-0 whitespace-pre-wrap text-foreground">
            {c.text}
          </span>
        </div>
      ))}
    </SectionCard>
  );
}

// ── System messages ───────────────────────────────────────────────────────

/** System entries: centered pills — "the room speaking", not a participant. */
export function SystemMessageView({ entry }: { entry: SystemEntry }) {
  const kindStyles = {
    info: "border-border bg-card text-muted-foreground",
    success: "border-additions/30 bg-additions/10 text-additions",
    error: "border-destructive/30 bg-destructive/10 text-destructive",
  };
  return (
    <MessageShell role="system">
      <div
        className={cn(
          "self-center rounded-full border px-3.5 py-1 text-[11.5px]",
          kindStyles[entry.kind],
        )}
      >
        {entry.text}
      </div>
    </MessageShell>
  );
}

// ── Assistant turns: the work section ─────────────────────────────────────
//
// Every step the agent takes collapses to one line with a fixed grammar —
// status · glyph · verb · object (mono) · outcome · chevron — and expands in
// place to its kind-specific payload (terminal output, diff, args, results).
// The work section itself is open by default (the live step catches the eye);
// its header carries the turn summary so collapsing it loses no orientation.

/** Whether a block is "work" (a step row) vs. prose. */
function isWorkBlock(b: Block): boolean {
  return b.type === "reasoning" || b.type === "tool";
}

/** Todo-list updates render in the ActiveTodoStrip above the composer, not the transcript. */
function isTodoTool(b: Block): boolean {
  if (b.type !== "tool") return false;
  const input = (b.input ?? {}) as Record<string, unknown>;
  return (
    input.todos !== undefined || b.name === "todowrite" || b.name === "todo"
  );
}

function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 0.05) return "";
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** +added/−removed line counts for a diff (synthesized from old/new text). */
function diffStats(diff: DiffBlock): { add: number; del: number } {
  const unified = synthesizeDiff(diff.oldText ?? "", diff.newText);
  let add = 0;
  let del = 0;
  for (const line of unified.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++;
    else if (line.startsWith("-") && !line.startsWith("---")) del++;
  }
  return { add, del };
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/** The per-kind step descriptor: icon + verb + object for the collapsed line.
 *  Matches both ACP ToolKind-derived names and opencode's own tool names, and
 *  falls back gracefully — the protocol is non-exhaustive by design. */
function describeTool(block: ToolBlock): {
  Icon: LucideIcon;
  verb: string;
  obj: string;
  kind: string;
} {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const file =
    str(input.filePath) ?? str(input.file) ?? str(input.path) ?? undefined;
  const title = block.title ?? "";
  switch (block.name) {
    case "read":
      return { Icon: FileText, verb: "Read", obj: file ?? title, kind: "read" };
    case "edit":
    case "multiedit":
    case "patch":
      return { Icon: Pencil, verb: "Edited", obj: file ?? title, kind: "edit" };
    case "write":
      return { Icon: Pencil, verb: "Wrote", obj: file ?? title, kind: "edit" };
    case "bash":
    case "shell":
    case "run":
    case "execute":
      return {
        Icon: Terminal,
        verb: "Ran",
        obj: str(input.command) ?? str(input.cmd) ?? title,
        kind: "execute",
      };
    case "search":
    case "grep":
    case "glob":
    case "rg":
      return {
        Icon: Search,
        verb: "Searched",
        obj: str(input.pattern) ?? str(input.query) ?? str(input.glob) ?? title,
        kind: "search",
      };
    case "list":
    case "ls":
      return {
        Icon: Search,
        verb: "Listed",
        obj: file ?? title,
        kind: "search",
      };
    case "fetch":
    case "webfetch":
      return {
        Icon: Globe,
        verb: "Fetched",
        obj: str(input.url) ?? title,
        kind: "fetch",
      };
    case "task":
    case "agent":
    case "subagent":
      return {
        Icon: Bot,
        verb: "Subagent",
        obj: str(input.description) ?? str(input.prompt) ?? title,
        kind: "task",
      };
    case "delete":
    case "rm":
      return {
        Icon: Trash2,
        verb: "Deleted",
        obj: file ?? title,
        kind: "other",
      };
    case "move":
    case "mv":
      return {
        Icon: MoveRight,
        verb: "Moved",
        obj: file ?? title,
        kind: "other",
      };
    default:
      return {
        Icon: Wrench,
        verb: block.name.charAt(0).toUpperCase() + block.name.slice(1),
        obj: title,
        kind: "other",
      };
  }
}

/** Right-aligned outcome slot on the collapsed line: numbers, never sentences. */
function toolOutcome(block: ToolBlock, kind: string): React.ReactNode {
  if (kind === "edit" && block.diff) {
    const { add, del } = diffStats(block.diff);
    return (
      <span className="font-mono tabular-nums">
        <span className="text-additions">+{add}</span>{" "}
        <span className="text-deletions">−{del}</span>
      </span>
    );
  }
  if (kind === "search" && block.output != null) {
    const n = block.output.split("\n").filter((l) => l.trim()).length;
    return (
      <span className="tabular-nums">
        {n} result{n === 1 ? "" : "s"}
      </span>
    );
  }
  if (kind === "read") {
    const line = block.locations?.find((l) => l.line != null)?.line;
    if (line != null) return <span className="tabular-nums">L{line}</span>;
  }
  return null;
}

interface TurnViewProps {
  entry: AssistantEntry;
  /** Pending permission requests belonging to this entry (by entrySeq). */
  permissions?: ChatPermissionEvent[];
  onAnswerPermission?: (requestId: string, optionId: string | null) => void;
}

/**
 * Renders one assistant turn: the work section (step rows, open by default),
 * prose below it, and a quiet footer with the turn duration. Live and
 * finished turns present identically — the live turn updates in place.
 */
export function AssistantTurnView({
  entry,
  permissions = [],
  onAnswerPermission,
}: TurnViewProps) {
  const work = entry.blocks.filter(isWorkBlock).filter((b) => !isTodoTool(b));
  const prose = entry.blocks.filter((b) => !isWorkBlock(b));
  const failed = entry.status === "failed";
  const duration = entry.endedAt ? entry.endedAt - entry.startedAt : null;
  // Permissions whose tool call isn't (yet) a block render at the section end.
  const workCallIds = new Set(
    work.filter((b) => b.type === "tool").map((b) => b.callId),
  );
  const orphanPerms = permissions.filter(
    (p) => !p.toolCallId || !workCallIds.has(p.toolCallId),
  );

  return (
    <>
      {work.length > 0 && (
        <WorkSection
          entry={entry}
          work={work}
          permissions={permissions}
          orphanPerms={orphanPerms}
          onAnswerPermission={onAnswerPermission}
        />
      )}
      {work.length === 0 &&
        orphanPerms.map((p) => (
          <PermissionCard
            key={p.requestId}
            permission={p}
            onAnswer={onAnswerPermission}
          />
        ))}
      {prose.map((b) => (
        <ProseBlock key={b.blockId} block={b} />
      ))}
      {failed && (
        <div className="text-xs text-destructive">
          The turn ended with an error.
        </div>
      )}
      {!failed && duration !== null && fmtDuration(duration) && (
        <div className="flex gap-2 text-[10.5px] tabular-nums text-muted-foreground/70">
          <span>{fmtDuration(duration)}</span>
          {entry.usage?.input != null && entry.usage?.output != null && (
            <>
              <span>·</span>
              <span>
                {(entry.usage.input / 1000).toFixed(1)}k in /{" "}
                {(entry.usage.output / 1000).toFixed(1)}k out
              </span>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** The turn's work: a summary header (always open by default) over step rows. */
function WorkSection({
  entry,
  work,
  permissions,
  orphanPerms,
  onAnswerPermission,
}: {
  entry: AssistantEntry;
  work: Block[];
  permissions: ChatPermissionEvent[];
  orphanPerms: ChatPermissionEvent[];
  onAnswerPermission?: (requestId: string, optionId: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const live =
    entry.status === "queued" ||
    entry.status === "streaming" ||
    entry.status === "awaitingPermission";
  const headline =
    entry.summary.headline ||
    (live
      ? `Working — ${work.length} step${work.length === 1 ? "" : "s"}`
      : `Worked ${work.length} step${work.length === 1 ? "" : "s"}`);

  // Header meta: commands run, aggregate diff, duration.
  const commands =
    entry.summary.commandsRun ||
    work.filter((b) => b.type === "tool" && describeTool(b).kind === "execute")
      .length;
  let add = 0;
  let del = 0;
  for (const b of work) {
    if (b.type === "tool" && b.diff) {
      const s = diffStats(b.diff);
      add += s.add;
      del += s.del;
    }
  }
  const duration = entry.endedAt ? entry.endedAt - entry.startedAt : null;

  return (
    <SectionCard
      onHeaderClick={() => setOpen((v) => !v)}
      header={
        <>
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="min-w-0 truncate">{headline}</span>
          {live && (
            <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2.5 font-mono text-[10.5px] tabular-nums">
            {commands > 0 && (
              <span>
                {commands} cmd{commands === 1 ? "" : "s"}
              </span>
            )}
            {(add > 0 || del > 0) && (
              <span>
                <span className="text-additions">+{add}</span>{" "}
                <span className="text-deletions">−{del}</span>
              </span>
            )}
            {duration !== null && fmtDuration(duration) && (
              <span>{fmtDuration(duration)}</span>
            )}
          </span>
        </>
      }
    >
      {open ? (
        <>
          {work.map((b) =>
            b.type === "reasoning" ? (
              <ThoughtStep
                key={b.blockId}
                text={b.text}
                live={live}
                last={b === work[work.length - 1]}
              />
            ) : b.type === "tool" ? (
              <ToolStep
                key={b.blockId}
                block={b}
                permission={permissions.find((p) => p.toolCallId === b.callId)}
                onAnswerPermission={onAnswerPermission}
              />
            ) : null,
          )}
          {orphanPerms.map((p) => (
            <PermissionCard
              key={p.requestId}
              permission={p}
              onAnswer={onAnswerPermission}
            />
          ))}
        </>
      ) : undefined}
    </SectionCard>
  );
}

/** Shared collapsed-line chrome for one step. */
function StepRowShell({
  leading,
  verb,
  obj,
  objTitle,
  aux,
  open,
  onToggle,
  children,
}: {
  leading: React.ReactNode;
  verb: string;
  obj: string;
  objTitle?: string;
  aux?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="group flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {leading}
        </span>
        <span className="shrink-0 font-medium text-foreground">{verb}</span>
        <span
          className="min-w-0 truncate font-mono text-[11px]"
          title={objTitle ?? obj}
        >
          {obj}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[10.5px]">
          {aux}
          <ChevronRight
            className={cn(
              "size-3.5 opacity-0 transition-all group-hover:opacity-60",
              open && "rotate-90 opacity-60",
            )}
          />
        </span>
      </button>
      {open && children && (
        <div className="mb-1.5 ml-[26px] mr-2 mt-0.5 border-l-2 border-border pl-3">
          {children}
        </div>
      )}
    </div>
  );
}

/** A reasoning step: one-line preview, expands to the full thought (markdown). */
function ThoughtStep({
  text,
  live,
  last,
}: {
  text: string;
  live: boolean;
  last: boolean;
}) {
  const [open, setOpen] = useState(false);
  const preview = text.trim().split("\n")[0] ?? "";
  const thinking = live && last;
  return (
    <StepRowShell
      leading={
        thinking ? (
          <Loader2 className="size-3 animate-spin text-primary" />
        ) : (
          <Sparkles className="size-3.5 opacity-70" />
        )
      }
      verb={thinking ? "Thinking" : "Thought"}
      obj={preview}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      <div className="markdown-content text-xs text-muted-foreground">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </StepRowShell>
  );
}

/** A tool step: kind-specific verb/object/outcome, expands to its payload. */
function ToolStep({
  block,
  permission,
  onAnswerPermission,
}: {
  block: ToolBlock;
  permission?: ChatPermissionEvent;
  onAnswerPermission?: (requestId: string, optionId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { Icon, verb, obj, kind } = describeTool(block);
  const running = block.status === "pending" || block.status === "running";

  return (
    <>
      <StepRowShell
        leading={
          running ? (
            <Loader2 className="size-3 animate-spin text-primary" />
          ) : (
            <Icon
              className={cn(
                "size-3.5 opacity-70",
                block.status === "failed" && "text-destructive opacity-100",
              )}
            />
          )
        }
        verb={verb}
        obj={obj}
        aux={
          <>
            {block.status === "failed" && (
              <span className="font-semibold text-destructive">failed</span>
            )}
            {permission && (
              <span className="font-medium text-warning">needs permission</span>
            )}
            {toolOutcome(block, kind)}
            {block.startedAt != null &&
              block.endedAt != null &&
              fmtDuration(block.endedAt - block.startedAt) && (
                <span className="tabular-nums opacity-70">
                  {fmtDuration(block.endedAt - block.startedAt)}
                </span>
              )}
          </>
        }
        open={open}
        onToggle={() => setOpen((v) => !v)}
      >
        <ToolStepDetail block={block} kind={kind} obj={obj} />
      </StepRowShell>
      {permission && (
        <PermissionCard permission={permission} onAnswer={onAnswerPermission} />
      )}
    </>
  );
}

/** Kind-specific expanded payload. */
function ToolStepDetail({
  block,
  kind,
  obj,
}: {
  block: ToolBlock;
  kind: string;
  obj: string;
}) {
  if (kind === "edit" && block.diff) {
    const unified = synthesizeDiff(
      block.diff.oldText ?? "",
      block.diff.newText,
    );
    const { add, del } = diffStats(block.diff);
    return (
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center justify-between bg-secondary px-2.5 py-1 font-mono text-[10.5px]">
          <span className="truncate">{block.diff.path}</span>
          <span className="shrink-0 tabular-nums">
            <span className="text-additions">+{add}</span>{" "}
            <span className="text-deletions">−{del}</span>
          </span>
        </div>
        <UnifiedDiff hunks={parseDiff(unified)} />
      </div>
    );
  }

  if (kind === "execute") {
    return (
      <div className="overflow-x-auto rounded-lg border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed">
        <div className="whitespace-pre-wrap">
          <span className="select-none text-primary">❯ </span>
          <span className="text-foreground">{obj}</span>
        </div>
        {block.output && (
          <pre
            className={cn(
              "mt-1 max-h-64 select-text overflow-auto whitespace-pre-wrap break-all text-muted-foreground",
              block.status === "failed" && "text-destructive/90",
            )}
          >
            {block.output}
          </pre>
        )}
      </div>
    );
  }

  if (kind === "search" && block.output) {
    return (
      <pre className="max-h-64 select-text overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
        {block.output}
      </pre>
    );
  }

  if (kind === "task" && block.output) {
    return (
      <div className="markdown-content text-xs text-muted-foreground">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {block.output}
        </ReactMarkdown>
      </div>
    );
  }

  // Generic fallback: args grid + output. Never crashes on unknown kinds.
  const input = (block.input ?? {}) as Record<string, unknown>;
  const entries = Object.entries(input);
  return (
    <div className="flex flex-col gap-1.5 text-[11px]">
      {kind === "fetch" && str(input.url) && (
        <a
          href={str(input.url)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-info hover:underline"
        >
          {str(input.url)}
        </a>
      )}
      {entries.length > 0 && (
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <span className="font-mono text-muted-foreground">{key}</span>
              <pre className="select-text overflow-x-auto whitespace-pre-wrap break-all font-mono">
                {typeof value === "string"
                  ? value
                  : JSON.stringify(value, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
      {block.output && (
        <pre className="max-h-64 select-text overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono">
          {block.output}
        </pre>
      )}
      {!block.output && block.rawOutput != null && (
        <pre className="max-h-64 select-text overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono">
          {JSON.stringify(block.rawOutput, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** An ACP permission request, anchored under the tool step that asked. Loud
 *  on purpose — the whole turn is blocked on this choice. */
export function PermissionCard({
  permission,
  onAnswer,
}: {
  permission: ChatPermissionEvent;
  onAnswer?: (requestId: string, optionId: string | null) => void;
}) {
  const isAllow = (kind: string) => kind.startsWith("allow");
  return (
    <div className="mx-2 my-1.5 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs">
      <div className="mb-2 flex items-center gap-2 font-medium">
        <Lock className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0 truncate">
          {permission.title ?? "Allow this action?"}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {permission.options.map((o) => (
          <Button
            key={o.optionId}
            size="sm"
            variant={isAllow(o.kind) ? "default" : "outline"}
            className={cn(
              "h-6 px-2.5 text-xs",
              !isAllow(o.kind) && "text-destructive",
            )}
            onClick={() => onAnswer?.(permission.requestId, o.optionId)}
          >
            {o.name}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2.5 text-xs"
          onClick={() => onAnswer?.(permission.requestId, null)}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Prose blocks (the answer) and agent-produced files, outside the work section. */
function ProseBlock({ block }: { block: Block }) {
  if (block.type === "text") {
    return (
      <div className="markdown-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ node: _node, ...props }) => (
              <a {...props} target="_blank" rel="noreferrer" />
            ),
          }}
        >
          {block.text || ""}
        </ReactMarkdown>
      </div>
    );
  }
  if (block.type === "file") {
    return <FilePart name={block.name} url={block.url} mime={block.mime} />;
  }
  return null;
}

function FilePart({
  name,
  url,
  mime,
}: {
  name: string | null;
  url: string;
  mime: string | null;
}) {
  const isImage = mime?.startsWith("image/") ?? false;
  const [open, setOpen] = useState(false);

  if (isImage && url) {
    return (
      <>
        <button
          onClick={() => setOpen(true)}
          className="block h-[100px] w-[100px] overflow-hidden rounded-md border border-border bg-muted hover:ring-2 hover:ring-primary/50"
        >
          <img
            src={url}
            alt={name ?? "image"}
            className="h-full w-full object-cover"
          />
        </button>
        {open && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            onClick={() => setOpen(false)}
          >
            <button
              onClick={() => setOpen(false)}
              className="absolute right-4 top-4 rounded-full bg-background/80 p-2 text-foreground hover:bg-background"
            >
              <X className="size-5" />
            </button>
            <img
              src={url}
              alt={name ?? "image"}
              className="max-h-full max-w-full rounded-md object-contain"
            />
          </div>
        )}
      </>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>📎</span>
      <span className="truncate">{name ?? url ?? "file"}</span>
    </div>
  );
}
