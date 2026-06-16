import { useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Part, ToolState } from "../lib/types";
import { cn } from "@/lib/utils";

interface MessageProps {
  role: "user" | "assistant";
  children: React.ReactNode;
}

export function ChatMessage({ role, children }: MessageProps) {
  const isUser = role === "user";
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
            ? "self-start rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-2.5"
            : "w-full rounded-2xl rounded-tr-sm px-1 py-1 text-foreground",
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
    return <FilePart filename={part.filename} url={part.url} />;
  }
  return null;
}

function FilePart({ filename, url }: { filename?: string; url?: string }) {
  return (
    <div className="my-1 text-xs text-muted-foreground">
      📎 {filename ?? url ?? "file"}
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
    <div className="my-1 -ml-6 w-[calc(100%+1.5rem)] min-w-0 text-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-2 py-1 text-left"
      >
        <span className="flex w-6 items-center justify-center">
          {pending ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <span className="size-4" />
          )}
        </span>
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
      </button>
      {open && <ToolCallDetails part={part} />}
    </div>
  );
}

function ToolCallDetails({ part }: { part: Part }) {
  const state = part.state;
  if (!state) return null;

  const inputEntries = state.input ? Object.entries(state.input) : [];

  return (
    <div className="border-t border-border px-3 py-2">
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
      {state.error && (
        <div className="mt-2 text-destructive">{state.error}</div>
      )}
      {state.status && (
        <div className="mt-2 text-[11px] text-muted-foreground">Status: {state.status}</div>
      )}
    </div>
  );
}
