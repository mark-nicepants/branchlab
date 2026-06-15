import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  Eye,
  Rows3,
  Undo2,
} from "lucide-react";
import { discardFile, workspaceChanges, workspaceFileDiff } from "../../lib/api";
import type { FileChange } from "../../lib/types";
import { parseDiff, splitRows, type DiffHunk, type DiffLineType } from "@/lib/diff";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  workspaceId: string;
  focusedFile: string | null;
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
  onMarkAllViewed: (paths: string[]) => void;
}

type ViewKind = "unified" | "split";

/**
 * Center "Changes" tab: every changed file's full diff stacked vertically,
 * with per-file Discard / Mark viewed and a top bar (counts, viewed progress,
 * Unified/Split). Sourced from git (local working tree), polled live.
 */
export function ChangesView({
  workspaceId,
  focusedFile,
  viewed,
  onToggleViewed,
  onMarkAllViewed,
}: Props) {
  const [view, setView] = useState<ViewKind>("unified");
  const [files, setFiles] = useState<FileChange[]>([]);
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const [tick, setTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    workspaceChanges(workspaceId)
      .then(async (fs) => {
        if (cancelled) return;
        setFiles(fs);
        const entries = await Promise.all(
          fs.map(async (f) => [f.path, await workspaceFileDiff(workspaceId, f.path)] as const),
        );
        if (!cancelled) setDiffs(Object.fromEntries(entries));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, tick]);

  useEffect(() => {
    if (!focusedFile) return;
    const el = Array.from(scrollRef.current?.querySelectorAll("[data-file]") ?? []).find(
      (e) => e.getAttribute("data-file") === focusedFile,
    );
    el?.scrollIntoView({ block: "start" });
  }, [focusedFile, files.length]);

  const totalIns = files.reduce((s, f) => s + f.insertions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);
  const viewedCount = files.filter((f) => viewed.has(f.path)).length;

  async function discard(path: string) {
    await discardFile(workspaceId, path).catch(() => {});
    setTick((x) => x + 1);
  }

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No changes in this workspace.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-xs">
        <span className="text-muted-foreground">
          {files.length} files{" "}
          <span className="text-emerald-600 dark:text-emerald-400">+{totalIns}</span>{" "}
          <span className="text-red-600 dark:text-red-400">−{totalDel}</span>
        </span>
        <span className="text-muted-foreground">
          {viewedCount}/{files.length} viewed
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Segmented>
            <Seg active={view === "unified"} onClick={() => setView("unified")}>
              <Rows3 className="size-3.5" /> Unified
            </Seg>
            <Seg active={view === "split"} onClick={() => setView("split")}>
              <Columns2 className="size-3.5" /> Split
            </Seg>
          </Segmented>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onMarkAllViewed(files.map((f) => f.path))}
          >
            Mark all viewed
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto">
        {files.map((f) => {
          const isViewed = viewed.has(f.path);
          const open = openMap[f.path] ?? !isViewed;
          return (
            <DiffFile
              key={f.path}
              file={f}
              diff={diffs[f.path] ?? ""}
              view={view}
              viewed={isViewed}
              open={open}
              onToggleOpen={() => setOpenMap((m) => ({ ...m, [f.path]: !open }))}
              onToggleViewed={() => onToggleViewed(f.path)}
              onDiscard={() => void discard(f.path)}
            />
          );
        })}
      </div>
    </div>
  );
}

function Segmented({ children }: { children: React.ReactNode }) {
  return <div className="flex rounded-md border border-border p-0.5">{children}</div>;
}

function Seg({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded px-2 py-0.5 text-xs",
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

function DiffFile({
  file,
  diff,
  view,
  viewed,
  open,
  onToggleOpen,
  onToggleViewed,
  onDiscard,
}: {
  file: FileChange;
  diff: string;
  view: ViewKind;
  viewed: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onToggleViewed: () => void;
  onDiscard: () => void;
}) {
  const hunks = useMemo(() => parseDiff(diff), [diff]);
  return (
    <div data-file={file.path} className={cn("border-b border-border", viewed && "opacity-70")}>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card px-2 py-1.5 text-xs">
        <button onClick={onToggleOpen} className="shrink-0 text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
          {file.path}
        </span>
        <span className="shrink-0 font-mono">
          <span className="text-emerald-600 dark:text-emerald-400">+{file.insertions}</span>{" "}
          <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
        </span>
        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onDiscard}>
          <Undo2 className="size-3.5" /> Discard
        </Button>
        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onToggleViewed}>
          {viewed ? (
            <>
              <Check className="size-3.5 text-emerald-500" /> Viewed
            </>
          ) : (
            <>
              <Eye className="size-3.5" /> Mark viewed
            </>
          )}
        </Button>
      </div>
      {open && (view === "unified" ? <UnifiedBody hunks={hunks} /> : <SplitBody hunks={hunks} />)}
    </div>
  );
}

function bgFor(type: DiffLineType): string {
  if (type === "add") return "bg-emerald-500/10";
  if (type === "del") return "bg-red-500/10";
  return "";
}
const sign = (t: DiffLineType) => (t === "add" ? "+" : t === "del" ? "−" : " ");

const GUTTER = "w-10 shrink-0 select-none px-1 text-right text-muted-foreground/50";
const CODE = "min-w-0 flex-1 select-text whitespace-pre-wrap break-words px-1";

function UnifiedBody({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="font-mono text-[12px] leading-[1.5]">
      {hunks.map((h, i) => (
        <div key={i}>
          <div className="bg-muted/40 px-2 py-0.5 text-sky-600 dark:text-sky-400">{h.header}</div>
          {h.lines.map((l, j) => (
            <div key={j} className={cn("flex", bgFor(l.type))}>
              <span className={GUTTER}>{l.oldNo ?? ""}</span>
              <span className={GUTTER}>{l.newNo ?? ""}</span>
              <span className="w-4 shrink-0 select-none text-center text-muted-foreground/60">
                {sign(l.type)}
              </span>
              <span className={CODE}>{l.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SplitBody({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="font-mono text-[12px] leading-[1.5]">
      {hunks.map((h, i) => (
        <div key={i}>
          <div className="bg-muted/40 px-2 py-0.5 text-sky-600 dark:text-sky-400">{h.header}</div>
          {splitRows(h).map((r, j) => (
            <div key={j} className="flex">
              <SplitSide line={r.left} which="old" />
              <span className="w-px shrink-0 bg-border" />
              <SplitSide line={r.right} which="new" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SplitSide({
  line,
  which,
}: {
  line: import("@/lib/diff").DiffLine | null;
  which: "old" | "new";
}) {
  if (!line) return <div className="flex-1 bg-muted/20" />;
  const no = which === "old" ? line.oldNo : line.newNo;
  return (
    <div className={cn("flex min-w-0 flex-1", bgFor(line.type))}>
      <span className={GUTTER}>{no ?? ""}</span>
      <span className={CODE}>{line.text || " "}</span>
    </div>
  );
}
