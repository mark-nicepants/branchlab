import { parseTypedDisplay, type TypedDisplay } from "@/lib/chatDisplay";
import { parseDiff, synthesizeDiff } from "@/lib/diff";
import { fileName } from "@/lib/review";
import { cn } from "@/lib/utils";
import { ChevronRight, Loader2, MessageSquare, X } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AssistantEntry,
  Block,
  SystemEntry,
  ToolBlock,
  UserEntry,
} from "../lib/types";
import { UnifiedDiff } from "./DiffBody";
import { usePreferences, type ChatDensity } from "./PreferencesProvider";

// ── Message base ──────────────────────────────────────────────────────────
//
// Every transcript entry renders inside a `MessageShell` (side, width, and
// density spacing — the one thing all message types share), then picks its
// chrome: the classic user bubble, a structured `MessageCard`, or bare
// content (assistant prose). New typed messages compose these primitives so
// user / assistant / system variants stay coherent.

/** Single source of truth for vertical spacing, keyed by chat density. */
const DENSITY: Record<
  ChatDensity,
  { assistant: string; userMargin: string; userPad: string; gap: string }
> = {
  tight: { assistant: "py-1", userMargin: "my-1", userPad: "py-2", gap: "gap-2" },
  loose: { assistant: "py-3", userMargin: "my-3", userPad: "py-2.5", gap: "gap-6" },
  roomy: { assistant: "py-5", userMargin: "my-5", userPad: "py-3", gap: "gap-10" },
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
      className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "flex flex-col select-text text-sm",
          d.gap,
          // Bubbles hug their content; cards span the column for a steady
          // silhouette across typed messages.
          isUser &&
            cn("max-w-[85%]", chrome === "none" && "w-full", d.userMargin),
          !isUser && "w-full max-w-[85%]",
          role === "assistant" && cn("max-w-full", d.assistant),
          role === "system" && d.assistant,
          chrome === "bubble" &&
            cn(
              "self-start rounded-2xl rounded-tl-sm border border-border bg-card px-4",
              d.userPad,
            ),
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Shared chrome for structured messages: header (icon · title · badge),
 *  body, and an optional muted footer. Used by typed user messages today;
 *  system/assistant cards should compose the same shape. */
export function MessageCard({
  icon,
  title,
  badge,
  footer,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  badge?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
        {icon && <span className="shrink-0 text-primary">{icon}</span>}
        <span className="min-w-0 truncate text-sm font-semibold">{title}</span>
        {badge && (
          <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary">
            {badge}
          </span>
        )}
      </div>
      <div className="px-4 py-3">{children}</div>
      {footer && (
        <div className="border-t border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
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
        <div className="whitespace-pre-wrap">{entry.display}</div>
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

/** Batched inline review comments, sent from the Changes panel. */
function ReviewFeedbackMessage({ payload }: { payload: TypedDisplay }) {
  const files = new Set(payload.comments.map((c) => c.file)).size;
  return (
    <MessageCard
      icon={<MessageSquare className="size-4" />}
      title="Review feedback"
      badge={`${plural(payload.comments.length, "comment")} · ${plural(files, "file")}`}
      footer="The agent receives each comment with its file, line number, and the exact line content."
    >
      <div className="flex flex-col gap-2.5">
        {payload.comments.map((c, i) => (
          <div key={i} className="flex items-baseline gap-3">
            <span
              className="shrink-0 font-mono text-xs text-primary"
              title={c.file}
            >
              {fileName(c.file)}:{c.line}
            </span>
            <span className="min-w-0 whitespace-pre-wrap">{c.text}</span>
          </div>
        ))}
      </div>
    </MessageCard>
  );
}

// ── System messages ───────────────────────────────────────────────────────

export function SystemMessageView({ entry }: { entry: SystemEntry }) {
  const kindStyles = {
    info: "border-border bg-muted/50 text-muted-foreground",
    success: "border-additions/30 bg-additions/10 text-additions",
    error: "border-destructive/30 bg-destructive/10 text-destructive",
  };
  return (
    <MessageShell role="system">
      <div
        className={cn(
          "self-start rounded-lg border px-3 py-1.5 text-xs",
          kindStyles[entry.kind],
        )}
      >
        {entry.text}
      </div>
    </MessageShell>
  );
}

/** Whether a block is "work" (grouped under the collapse header) vs. prose. */
export function isWorkBlock(b: Block): boolean {
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

/**
 * Renders one assistant turn. The reasoning/tool "work" always lives in one
 * collapsible panel — live and finished turns present identically (the live
 * turn's panel updates in place and is continuously persisted backend-side, so
 * switching sessions mid-turn loses nothing). Prose renders below the panel.
 */
export function AssistantTurnView({ entry }: { entry: AssistantEntry }) {
  const work = entry.blocks.filter(isWorkBlock).filter((b) => !isTodoTool(b));
  const prose = entry.blocks.filter((b) => !isWorkBlock(b));
  const failed = entry.status === "failed";
  const live = entry.status === "queued" || entry.status === "streaming";
  // A freshly streaming entry has no backend headline yet — derive a live one.
  const headline =
    entry.summary.headline ||
    (work.length > 0
      ? `Working — ${work.length} step${work.length === 1 ? "" : "s"}`
      : "Working…");

  return (
    <>
      {work.length > 0 && (
        <CollapsedWork headline={headline} blocks={work} live={live} />
      )}
      {prose.map((b) => (
        <BlockView key={b.blockId} block={b} />
      ))}
      {failed && (
        <div className="text-xs text-destructive">
          The turn ended with an error.
        </div>
      )}
    </>
  );
}

function CollapsedWork({
  headline,
  blocks,
  live,
}: {
  headline: string;
  blocks: Block[];
  live?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full min-w-0 text-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-2 py-0.5 text-left text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 truncate">{headline}</span>
        {live && (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        )}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-2 border-l border-border pl-3">
          {blocks.map((b) => (
            <BlockView key={b.blockId} block={b} />
          ))}
        </div>
      )}
    </div>
  );
}

export function BlockView({ block }: { block: Block }) {
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
  if (block.type === "reasoning") {
    return (
      <div className="text-xs italic text-muted-foreground">{block.text}</div>
    );
  }
  if (block.type === "tool") {
    return <ToolCallView block={block} />;
  }
  return <FilePart name={block.name} url={block.url} mime={block.mime} />;
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

const TOOL_LABELS: Record<string, string> = {
  edit: "Edit file",
  write: "Write file",
  read: "Read file",
  bash: "Run command",
  todowrite: "Update todos",
  todo: "Update todos",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The description shown next to the label, plus a tooltip with the full
 *  value. File tools show just `name.ext` — the full path lives in the title. */
function toolDescription(block: ToolBlock): { text: string; full: string } {
  const input = (block.input ?? {}) as Record<string, unknown>;
  if (
    block.name === "read" ||
    block.name === "edit" ||
    block.name === "write"
  ) {
    const file =
      asString(input.file) ?? asString(input.path) ?? asString(input.filePath);
    if (file) return { text: file.split("/").pop() ?? file, full: file };
  }
  const t = block.title ?? "";
  return { text: t, full: t };
}

function ToolCallView({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const pending = block.status === "pending" || block.status === "running";
  const description = toolDescription(block);

  return (
    <div className="w-full min-w-0 text-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full flex-col items-start py-0.5 text-left"
      >
        <div className="flex w-full items-center gap-2">
          <span className="shrink-0 font-medium">{toolLabel(block.name)}</span>
          {description.text && (
            <span
              className="min-w-0 truncate text-muted-foreground"
              title={description.full}
            >
              {description.text}
            </span>
          )}
          {block.status === "failed" && (
            <span className="shrink-0 text-destructive">failed</span>
          )}
          <span className="ml-auto shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
            <ChevronRight
              className={cn(
                "size-4 text-muted-foreground",
                open && "rotate-90",
              )}
            />
          </span>
        </div>
        {pending && (
          <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-[shimmer_1s_infinite] bg-primary/70" />
          </div>
        )}
      </button>
      {open && <ToolCallDetails block={block} />}
    </div>
  );
}

function ToolCallDetails({ block }: { block: ToolBlock }) {
  // Edit/Write: render the diff (ACP-provided unified, or synthesized from
  // old/new text), then any error.
  if ((block.name === "edit" || block.name === "write") && block.diff) {
    const { diff } = block;
    const unified =
      diff.unified ?? synthesizeDiff(diff.oldText ?? "", diff.newText);
    return (
      <div className="overflow-hidden rounded border border-border">
        <UnifiedDiff hunks={parseDiff(unified)} />
        {block.error && (
          <div className="border-t border-border p-2 text-destructive">
            {block.error}
          </div>
        )}
      </div>
    );
  }

  const input = (block.input ?? {}) as Record<string, unknown>;
  const inputEntries = Object.entries(input);
  return (
    <div className="rounded border border-border px-3 py-2">
      {inputEntries.length > 0 && (
        <div className="mb-2 space-y-1">
          {inputEntries.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[80px_1fr] gap-2">
              <span className="text-muted-foreground">{key}</span>
              <pre className="select-text overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                {typeof value === "string"
                  ? value
                  : JSON.stringify(value, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
      {block.output && (
        <pre className="mt-2 max-h-48 select-text overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px]">
          {block.output}
        </pre>
      )}
      {block.error && (
        <div className="mt-2 text-destructive">{block.error}</div>
      )}
      <div className="mt-2 text-[11px] text-muted-foreground">
        Status: {block.status}
      </div>
    </div>
  );
}
