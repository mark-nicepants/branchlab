import { useState } from "react";
import { FileWarning, Loader2, TriangleAlert } from "lucide-react";
import { readFile } from "../../lib/api";
import type { FileContent } from "../../lib/types";
import { EmptyState } from "@/components/ui/empty-state";
import { useCancellableEffect } from "../../hooks/useCancellableEffect";

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: FileContent }
  | { kind: "error"; message: string };

/**
 * Center "file" tab: a read-only, line-numbered view of a single workspace
 * file. Handles loading, errors, binary files, and large (truncated) files.
 */
export function FileView({ workspaceId, file }: { workspaceId: string; file: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useCancellableEffect(
    (cancelled) => {
      setState({ kind: "loading" });
      readFile(workspaceId, file)
        .then((data) => !cancelled() && setState({ kind: "ready", data }))
        .catch((e) => !cancelled() && setState({ kind: "error", message: String(e) }));
    },
    [workspaceId, file],
  );

  if (state.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading file…
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <EmptyState icon={<TriangleAlert className="size-6 text-destructive" />}>
        Could not open this file.
        <span className="mt-1 block font-mono text-xs">{state.message}</span>
      </EmptyState>
    );
  }

  const { data } = state;

  if (data.binary) {
    return (
      <EmptyState icon={<FileWarning className="size-6 text-muted-foreground/60" />}>
        Binary file not shown ({formatBytes(data.size)}).
      </EmptyState>
    );
  }

  // Drop the trailing empty line produced by a final newline.
  const lines = data.content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-mono" title={file}>
          {file}
        </span>
        <span className="shrink-0">
          {lines.length} lines · {formatBytes(data.size)}
        </span>
        {data.truncated && <span className="shrink-0 text-warning">truncated</span>}
      </div>

      <div className="flex-1 overflow-auto font-mono text-[12px] leading-[1.5]">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span className="w-12 shrink-0 select-none px-2 text-right text-muted-foreground/50">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words px-2">
              {line || " "}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
