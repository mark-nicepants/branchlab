import { ChevronRight, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState } from "react";
import type { Part, ToolState } from "../lib/types";
import { cn } from "@/lib/utils";
import { usePreferences, type ChatDensity } from "./PreferencesProvider";
import { parseDiff } from "@/lib/diff";
import { UnifiedDiff } from "./DiffBody";

interface MessageProps {
  role: "user" | "assistant";
  children: React.ReactNode;
}

// Single source of truth for vertical spacing of message bubbles. Each density
// pairs an assistant-bubble class with a user-bubble class so adjacent
// messages always contribute uniform breathing room regardless of contents.
// Add new modes here; everything else flows from prefs.chatDensity.
const DENSITY: Record<ChatDensity, { assistant: string; user: string }> = {
  tight: { assistant: "py-1", user: "my-1 py-2" },
  loose: { assistant: "py-3", user: "my-3 py-2.5" },
  roomy: { assistant: "py-5", user: "my-5 py-3" },
};

export function ChatMessage({ role, children }: MessageProps) {
  const { prefs } = usePreferences();
  const isUser = role === "user";
  const d = DENSITY[prefs.chatDensity] ?? DENSITY.loose;
  return (
    <div
      className={cn(
        "flex w-full",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[85%] select-text text-sm",
          isUser
            ? cn("self-start rounded-2xl rounded-tl-sm border border-border bg-card px-4", d.user)
            : cn("w-full rounded-2xl rounded-tr-sm px-0 text-foreground", d.assistant),
        )}
      >
        {children}
      </div>
    </div>
  );
}

interface PartViewProps {
  part: Part;
}

export function PartView({ part }: PartViewProps) {
  if (part.type === "text") {
    return (
      <div className="markdown-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text || ""}</ReactMarkdown>
      </div>
    );
  }
  if (part.type === "reasoning") {
    return (
      <div className="my-1 text-xs italic text-muted-foreground">
        {part.text}
      </div>
    );
  }
  if (part.type === "tool") {
    return <ToolCallPart part={part} />;
  }
  if (part.type === "file") {
    return <FilePart filename={part.filename} url={part.url} mime={part.mime} />;
  }
  return null;
}

function FilePart({ filename, url, mime }: { filename?: string; url?: string; mime?: string }) {
  const isImage = mime?.startsWith("image/") ?? false;
  const [open, setOpen] = useState(false);

  if (isImage && url) {
    return (
      <>
        <button
          onClick={() => setOpen(true)}
          className="my-1 block h-[100px] w-[100px] overflow-hidden rounded-md border border-border bg-muted hover:ring-2 hover:ring-primary/50"
        >
          <img
            src={url}
            alt={filename ?? "image"}
            className="h-full w-full object-cover"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(true);
            }}
          />
        </button>
        {open && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
            onClick={() => setOpen(false)}
          >
            <button
              onClick={() => setOpen(false)}
              className="absolute top-4 right-4 rounded-full bg-background/80 p-2 text-foreground hover:bg-background"
            >
              <X className="size-5" />
            </button>
            <img
              src={url}
              alt={filename ?? "image"}
              className="max-h-full max-w-full rounded-md object-contain"
            />
          </div>
        )}
      </>
    );
  }

  return (
    <div className="my-1 flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>📎</span>
      <span className="truncate">{filename ?? url ?? "file"}</span>
    </div>
  );
}

/** Maps raw tool names to human-readable labels. */
const TOOL_LABELS: Record<string, string> = {
  edit: "Edit file",
  write: "Write file",
  read: "Read file",
  bash: "Run command",
  todowrite: "Update todos",
  todo: "Update todos",
};

function toolLabel(tool?: string): string {
  if (!tool) return "Tool";
  return TOOL_LABELS[tool] ?? tool;
}

function isPending(state?: ToolState): boolean {
  return state?.status === "pending" || state?.status === "running";
}

function toolDescription(part: Part): string {
  const input = part.state?.input;
  if (part.tool === "read" || part.tool === "edit" || part.tool === "write") {
    const file =
      typeof input?.file === "string"
        ? input.file
        : typeof input?.path === "string"
          ? input.path
          : undefined;
    if (file) return file;
  }
  if (part.tool === "bash") {
    return part.state?.title ?? "";
  }
  return part.state?.title ?? "";
}

function ToolCallPart({ part }: { part: Part }) {
  const [open, setOpen] = useState(false);
  const pending = isPending(part.state);
  const label = toolLabel(part.tool);
  const description = toolDescription(part);

  return (
    <div className="w-full min-w-0 text-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full flex-col items-start py-0.5 text-left"
      >
        <div className="flex w-full items-center gap-2">
          <span className="shrink-0 font-medium">{label}</span>
          {description && (
            <span className="min-w-0 truncate text-muted-foreground">{description}</span>
          )}
          <span className="ml-auto shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
            {open ? (
              <ChevronRight className="size-4 rotate-90 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )}
          </span>
        </div>
        {pending && (
          <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-[shimmer_1s_infinite] bg-primary/70" />
          </div>
        )}
      </button>
      {open && <ToolCallDetails part={part} />}
    </div>
  );
}

// Synthesize a unified diff from raw old/new strings so the existing diff
// renderer can display Edit/Write tool calls. No context lines — the whole
// old block shows as `−` and the whole new block as `+`, which matches the
// shape of an Edit's single-block replacement.
function synthesizeDiff(oldText: string, newText: string): string {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  const header = `@@ -1,${oldLines.length} +1,${newLines.length} @@`;
  const parts = [header];
  if (oldLines.length) parts.push(oldLines.map((l) => `-${l}`).join("\n"));
  if (newLines.length) parts.push(newLines.map((l) => `+${l}`).join("\n"));
  return parts.join("\n");
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function ToolCallDetails({ part }: { part: Part }) {
  const state = part.state;
  if (!state) return null;
  const input = state.input ?? {};

  // Edit: show oldString → newString as a unified diff.
  if (part.tool === "edit") {
    const oldStr =
      asString(input.oldString) ?? asString((input as Record<string, unknown>).old_string) ?? "";
    const newStr =
      asString(input.newString) ?? asString((input as Record<string, unknown>).new_string) ?? "";
    if (oldStr || newStr) {
      const hunks = parseDiff(synthesizeDiff(oldStr, newStr));
      return (
        <div className="overflow-hidden rounded border border-border">
          <UnifiedDiff hunks={hunks} />
        </div>
      );
    }
  }

  // Write: show the whole new file as additions.
  if (part.tool === "write") {
    const content = asString(input.content) ?? "";
    if (content) {
      const hunks = parseDiff(synthesizeDiff("", content));
      return (
        <div className="overflow-hidden rounded border border-border">
          <UnifiedDiff hunks={hunks} />
        </div>
      );
    }
  }

  // Generic fallback: input key/value table, then output / error / status.
  const inputEntries = Object.entries(input);
  return (
    <div className="rounded border border-border px-3 py-2">
      {inputEntries.length > 0 && (
        <div className="mb-2 space-y-1">
          {inputEntries.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[80px_1fr] gap-2">
              <span className="text-muted-foreground">{key}</span>
              <pre className="select-text overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
      {state.output && (
        <pre className="mt-2 max-h-48 select-text overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px]">
          {state.output}
        </pre>
      )}
      {state.error && <div className="mt-2 text-destructive">{state.error}</div>}
      {state.status && (
        <div className="mt-2 text-[11px] text-muted-foreground">Status: {state.status}</div>
      )}
    </div>
  );
}
