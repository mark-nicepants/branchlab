import { useEffect, useState } from "react";
import { CheckCircle2, Circle, FileDiff, Search } from "lucide-react";
import { workspaceChanges } from "../../lib/api";
import type { FileChange, Workspace } from "../../lib/types";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Props {
  workspace: Workspace | null;
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
  onOpenFile: (path: string) => void;
}

type Mode = "Local" | "Base";

const STATUS_STYLES: Record<string, { letter: string; className: string }> = {
  added: { letter: "A", className: "text-emerald-600 dark:text-emerald-400" },
  untracked: { letter: "U", className: "text-emerald-600 dark:text-emerald-400" },
  modified: { letter: "M", className: "text-amber-600 dark:text-amber-400" },
  deleted: { letter: "D", className: "text-red-600 dark:text-red-400" },
  renamed: { letter: "R", className: "text-sky-600 dark:text-sky-400" },
};

/**
 * Right panel: a compact navigator over the workspace's changed files. Clicking
 * a file opens it in the center "Changes" tab. The full diffs live there.
 */
export function ChangesPanel({ workspace, viewed, onToggleViewed, onOpenFile }: Props) {
  const [mode, setMode] = useState<Mode>("Local");
  const [files, setFiles] = useState<FileChange[]>([]);
  const [filter, setFilter] = useState("");
  const [tick, setTick] = useState(0);

  const hasBase = !!workspace?.base_branch;
  const against = mode === "Base" ? workspace?.base_branch ?? undefined : undefined;

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!hasBase) setMode("Local");
  }, [workspace?.id, hasBase]);

  useEffect(() => {
    if (!workspace) {
      setFiles([]);
      return;
    }
    workspaceChanges(workspace.id, against).then(setFiles).catch(() => {});
  }, [workspace?.id, against, tick]);

  const shown = files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex items-center gap-4 border-b border-border px-4 py-2.5 text-sm">
        <span className="font-medium">Changes</span>
        <span className="text-muted-foreground">Files</span>
        <span className="text-muted-foreground">History</span>
      </div>

      <div className="flex items-center gap-3 border-b border-border px-4 py-1.5 text-xs">
        <button
          className={mode === "Local" ? "font-medium" : "text-muted-foreground"}
          onClick={() => setMode("Local")}
        >
          Local
        </button>
        <button
          className={cn(
            mode === "Base" ? "font-medium" : "text-muted-foreground",
            !hasBase && "cursor-not-allowed opacity-40",
          )}
          disabled={!hasBase}
          onClick={() => hasBase && setMode("Base")}
        >
          Base
        </button>
      </div>

      {!workspace ? (
        <Empty>Select a workspace to see its changes.</Empty>
      ) : files.length === 0 ? (
        <Empty>No changes yet</Empty>
      ) : (
        <>
          <div className="relative px-3 py-2">
            <Search className="absolute top-1/2 left-5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter files…"
              className="h-7 pl-7 text-xs"
            />
          </div>
          <div className="flex-1 overflow-y-auto pb-1">
            {shown.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                viewed={viewed.has(f.path)}
                onClick={() => onOpenFile(f.path)}
                onToggleViewed={() => onToggleViewed(f.path)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <FileDiff className="size-6 text-muted-foreground/60" />
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function FileRow({
  file,
  viewed,
  onClick,
  onToggleViewed,
}: {
  file: FileChange;
  viewed: boolean;
  onClick: () => void;
  onToggleViewed: () => void;
}) {
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const s = STATUS_STYLES[file.status] ?? STATUS_STYLES.modified;

  return (
    <div className={cn("group/file flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent", viewed && "opacity-60")}>
      <span className={cn("w-3 shrink-0 text-center font-mono text-xs font-semibold", s.className)}>
        {s.letter}
      </span>
      <button className="flex min-w-0 flex-1 items-center text-left" onClick={onClick} title={file.path}>
        <span className="min-w-0 flex-1 truncate">
          {dir && <span className="text-muted-foreground">{dir}</span>}
          {name}
        </span>
      </button>
      <span className="shrink-0 font-mono text-[11px]">
        {file.insertions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{file.insertions}</span>}{" "}
        {file.deletions > 0 && <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>}
      </span>
      <button
        className="shrink-0 text-muted-foreground hover:text-foreground"
        title={viewed ? "Mark not viewed" : "Mark viewed"}
        onClick={onToggleViewed}
      >
        {viewed ? (
          <CheckCircle2 className="size-4 text-emerald-500" />
        ) : (
          <Circle className="size-4" />
        )}
      </button>
    </div>
  );
}
