import { parseDiff, synthesizeDiff } from "@/lib/diff";
import { cn } from "@/lib/utils";
import { ChevronRight, X } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AssistantEntry,
  Block,
  SystemEntry,
  ToolBlock,
} from "../lib/types";
import { UnifiedDiff } from "./DiffBody";
import { usePreferences, type ChatDensity } from "./PreferencesProvider";

interface MessageProps {
  role: "user" | "assistant";
  children: React.ReactNode;
}

// Single source of truth for vertical spacing (see original design notes).
const DENSITY: Record<
  ChatDensity,
  { assistant: string; user: string; gap: string }
> = {
  tight: { assistant: "py-1", user: "my-1 py-2", gap: "gap-2" },
  loose: { assistant: "py-3", user: "my-3 py-2.5", gap: "gap-6" },
  roomy: { assistant: "py-5", user: "my-5 py-3", gap: "gap-10" },
};

export function ChatMessage({ role, children }: MessageProps) {
  const { prefs } = usePreferences();
  const isUser = role === "user";
  const d = DENSITY[prefs.chatDensity] ?? DENSITY.loose;
  return (
    <div
      className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "flex max-w-[85%] flex-col select-text text-sm",
          d.gap,
          isUser
            ? cn(
                "self-start rounded-2xl rounded-tl-sm border border-border bg-card px-4",
                d.user,
              )
            : cn(
                "w-full rounded-2xl rounded-tr-sm px-0 text-foreground",
                d.assistant,
              ),
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function SystemMessageView({ entry }: { entry: SystemEntry }) {
  const { prefs } = usePreferences();
  const d = DENSITY[prefs.chatDensity] ?? DENSITY.loose;
  const kindStyles = {
    info: "border-border bg-muted/50 text-muted-foreground",
    success: "border-additions/30 bg-additions/10 text-additions",
    error: "border-destructive/30 bg-destructive/10 text-destructive",
  };
  return (
    <div className={cn("flex w-full justify-start", d.assistant)}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg border px-3 py-1.5 text-xs",
          kindStyles[entry.kind],
        )}
      >
        {entry.text}
      </div>
    </div>
  );
}

/** Whether a block is "work" (grouped under the collapse header) vs. prose. */
export function isWorkBlock(b: Block): boolean {
  return b.type === "reasoning" || b.type === "tool";
}

/**
 * Renders one assistant turn. While the turn is live (not collapsed), all blocks
 * show inline. Once the turn finishes, its reasoning/tool "work" collapses under
 * a deterministic headline ("Edited 3 files · ran 5 commands"); the final text
 * stays visible below.
 */
export function AssistantTurnView({ entry }: { entry: AssistantEntry }) {
  const collapsed = entry.summary.collapsed;
  const work = entry.blocks.filter(isWorkBlock);
  const prose = entry.blocks.filter((b) => !isWorkBlock(b));
  const failed = entry.status === "failed";

  return (
    <>
      {collapsed && work.length > 0 ? (
        <CollapsedWork headline={entry.summary.headline} blocks={work} />
      ) : (
        work.map((b) => <BlockView key={b.blockId} block={b} />)
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
}: {
  headline: string;
  blocks: Block[];
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

function toolDescription(block: ToolBlock): string {
  const input = (block.input ?? {}) as Record<string, unknown>;
  if (
    block.name === "read" ||
    block.name === "edit" ||
    block.name === "write"
  ) {
    const file =
      asString(input.file) ?? asString(input.path) ?? asString(input.filePath);
    if (file) return file;
  }
  return block.title ?? "";
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
          {description && (
            <span className="min-w-0 truncate text-muted-foreground">
              {description}
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
