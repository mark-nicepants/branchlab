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
import { discardFile, workspaceFileDiff } from "../../lib/api";
import type { FileChange } from "../../lib/types";
import { parseDiff } from "@/lib/diff";
import { UnifiedDiff, SplitDiff } from "../DiffBody";
import { Button } from "@/components/ui/button";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { useWorkspaceData } from "../../hooks/useWorkspaceData";
import { useCancellableEffect } from "../../hooks/useCancellableEffect";
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
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const { changes, refreshChanges } = useWorkspaceData();
  const files: FileChange[] = changes ?? [];
  // Stable signature so we only refetch per-file diffs when the set changes,
  // not on every poll cycle even when the file list hasn't changed.
  const signature = files
    .map((f) => `${f.path}:${f.insertions}/${f.deletions}`)
    .join(",");

  useCancellableEffect(
    async (cancelled) => {
      const entries = await Promise.all(
        files.map(
          async (f) =>
            [f.path, await workspaceFileDiff(workspaceId, f.path)] as const,
        ),
      );
      if (!cancelled()) setDiffs(Object.fromEntries(entries));
    },
    [workspaceId, signature],
  );

  useEffect(() => {
    if (!focusedFile) return;
    const el = Array.from(
      scrollRef.current?.querySelectorAll("[data-file]") ?? [],
    ).find((e) => e.getAttribute("data-file") === focusedFile);
    el?.scrollIntoView({ block: "start" });
  }, [focusedFile, files.length]);

  const totalIns = files.reduce((s, f) => s + f.insertions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);
  const viewedCount = files.filter((f) => viewed.has(f.path)).length;

  async function discard(path: string) {
    await discardFile(workspaceId, path).catch(() => {});
    refreshChanges();
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
          <span className="text-additions">+{totalIns}</span>{" "}
          <span className="text-deletions">−{totalDel}</span>
        </span>
        <span className="text-muted-foreground">
          {viewedCount}/{files.length} viewed
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Segmented>
            <SegmentedItem
              active={view === "unified"}
              onClick={() => setView("unified")}
            >
              <Rows3 className="size-3.5" /> Unified
            </SegmentedItem>
            <SegmentedItem
              active={view === "split"}
              onClick={() => setView("split")}
            >
              <Columns2 className="size-3.5" /> Split
            </SegmentedItem>
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
              onToggleOpen={() =>
                setOpenMap((m) => ({ ...m, [f.path]: !open }))
              }
              onToggleViewed={() => onToggleViewed(f.path)}
              onDiscard={() => void discard(f.path)}
            />
          );
        })}
      </div>
    </div>
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
    <div
      data-file={file.path}
      className={cn("border-b border-border", viewed && "opacity-70")}
    >
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card px-2 py-1.5 text-xs">
        <button
          onClick={onToggleOpen}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          {open ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>
        <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
          {file.path}
        </span>
        <span className="shrink-0 font-mono">
          <span className="text-additions">+{file.insertions}</span>{" "}
          <span className="text-deletions">−{file.deletions}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={onDiscard}
        >
          <Undo2 className="size-3.5" /> Discard
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={onToggleViewed}
        >
          {viewed ? (
            <>
              <Check className="size-3.5 text-additions" /> Viewed
            </>
          ) : (
            <>
              <Eye className="size-3.5" /> Mark viewed
            </>
          )}
        </Button>
      </div>
      {open &&
        (view === "unified" ? (
          <UnifiedDiff hunks={hunks} />
        ) : (
          <SplitDiff hunks={hunks} />
        ))}
    </div>
  );
}
