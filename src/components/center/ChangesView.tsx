import { Button } from "@/components/ui/button";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { parseDiff } from "@/lib/diff";
import {
  turnFilePaths,
  type ChangeScope,
  type LastTurnInfo,
  type NewReviewComment,
  type ReviewComment,
} from "@/lib/review";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  Eye,
  MessageSquare,
  Rows3,
  Send,
  Undo2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCancellableEffect } from "../../hooks/useCancellableEffect";
import { useWorkspaceData } from "../../hooks/useWorkspaceData";
import { discardFile, workspaceFileDiff } from "../../lib/api";
import type { FileChange } from "../../lib/types";
import { SplitDiff, UnifiedDiff, type DiffCommenting } from "../DiffBody";

interface Props {
  workspaceId: string;
  focusedFile: string | null;
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
  onMarkAllViewed: (paths: string[]) => void;
  lastTurn: LastTurnInfo | null;
  /** Scope lives in SessionView so the list and detail views stay in sync. */
  scope: ChangeScope;
  onScopeChange: (s: ChangeScope) => void;
  /** Changes when the newest assistant turn progresses — re-fetches per-file
   *  diffs even when a file's +/− counts happen to stay identical. */
  diffNonce: string;
  comments: ReviewComment[];
  onAddComment: (c: NewReviewComment) => void;
  onRemoveComment: (id: string) => void;
  onClearComments: () => void;
  onSendComments: () => void;
  /** True while the assistant is running — sending review feedback waits. */
  busy: boolean;
}

type ViewKind = "unified" | "split";

/**
 * Center "Changes" tab: every changed file's full diff stacked vertically,
 * scoped to the last AI turn or to all changes, with PR-style inline review
 * comments batched into one chat message. Sourced from git, polled live.
 */
export function ChangesView({
  workspaceId,
  focusedFile,
  viewed,
  onToggleViewed,
  onMarkAllViewed,
  lastTurn,
  scope,
  onScopeChange,
  diffNonce,
  comments,
  onAddComment,
  onRemoveComment,
  onClearComments,
  onSendComments,
  busy,
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
    [workspaceId, signature, diffNonce],
  );

  // ── Scope: last turn vs everything ──
  const turnPaths = useMemo(
    () => turnFilePaths(files, lastTurn),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature, lastTurn],
  );
  const turnAvailable = turnPaths.size > 0;
  const effScope: ChangeScope =
    scope === "turn" && turnAvailable ? "turn" : "all";
  const shown =
    effScope === "turn" ? files.filter((f) => turnPaths.has(f.path)) : files;
  const hiddenCount = files.length - shown.length;

  // Focus only scrolls; scope is shared with the list view, so a clicked file
  // is always in the current scope and toggling stays free afterwards.
  //
  // Diffs load async after mount and reflow everything above the target, so
  // scroll twice per focus at most: immediately (pending) and once more when
  // the diffs land — but never again on later live refreshes, which would
  // yank the user away from wherever they scrolled to.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusedFile) return;
    const key = `${focusedFile}:${diffs[focusedFile] ? "loaded" : "pending"}`;
    if (scrolledFor.current === key) return;
    const el = Array.from(
      scrollRef.current?.querySelectorAll("[data-file]") ?? [],
    ).find((e) => e.getAttribute("data-file") === focusedFile);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    scrolledFor.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedFile, shown.length, diffs]);

  const totalIns = shown.reduce((s, f) => s + f.insertions, 0);
  const totalDel = shown.reduce((s, f) => s + f.deletions, 0);
  const viewedCount = shown.filter((f) => viewed.has(f.path)).length;
  const commentFiles = new Set(comments.map((c) => c.file)).size;

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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-2 text-xs">
        <ScopeToggle
          scope={effScope}
          turnCount={turnPaths.size}
          allCount={files.length}
          onChange={onScopeChange}
        />
        <span className="text-muted-foreground">
          <span className="text-additions">+{totalIns}</span>{" "}
          <span className="text-deletions">−{totalDel}</span>
        </span>
        <span className="text-muted-foreground">
          {viewedCount}/{shown.length} viewed
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
            onClick={() => onMarkAllViewed(shown.map((f) => f.path))}
          >
            Mark all viewed
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto">
        {effScope === "turn" && hiddenCount > 0 && (
          <HiddenFilesNote
            count={hiddenCount}
            onShowAll={() => onScopeChange("all")}
          />
        )}
        {shown.map((f) => {
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
              inLastTurn={effScope === "all" && turnPaths.has(f.path)}
              commentCount={comments.filter((c) => c.file === f.path).length}
              commenting={{
                file: f.path,
                comments: comments.filter((c) => c.file === f.path),
                onAdd: onAddComment,
                onRemove: onRemoveComment,
              }}
              onToggleOpen={() =>
                setOpenMap((m) => ({ ...m, [f.path]: !open }))
              }
              onToggleViewed={() => onToggleViewed(f.path)}
              onDiscard={() => void discard(f.path)}
            />
          );
        })}
      </div>

      {comments.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-card px-3 py-2">
          <span className="text-xs text-muted-foreground">
            <span className="font-semibold text-warning">
              {comments.length} comment{comments.length === 1 ? "" : "s"}
            </span>{" "}
            pending across {commentFiles} file{commentFiles === 1 ? "" : "s"}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={onClearComments}
            >
              Discard all
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              title={busy ? "Waiting for the current turn to finish" : undefined}
              onClick={onSendComments}
            >
              <Send className="size-3.5" /> Send{" "}
              {comments.length === 1 ? "comment" : `${comments.length} comments`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** [Last turn N | All N] — shared by the changes list and the diff view.
 *  The "Last turn" segment is inert (dimmed) when the turn touched no files. */
export function ScopeToggle({
  scope,
  turnCount,
  allCount,
  onChange,
}: {
  scope: ChangeScope;
  turnCount: number;
  allCount: number;
  onChange: (s: ChangeScope) => void;
}) {
  return (
    <Segmented>
      <SegmentedItem
        active={scope === "turn"}
        onClick={() => turnCount > 0 && onChange("turn")}
      >
        <span className={cn(turnCount === 0 && "opacity-50")}>
          Last turn {turnCount > 0 ? turnCount : ""}
        </span>
      </SegmentedItem>
      <SegmentedItem active={scope === "all"} onClick={() => onChange("all")}>
        All {allCount}
      </SegmentedItem>
    </Segmented>
  );
}

/** "N earlier files hidden — show all changes" row above a turn-scoped list. */
export function HiddenFilesNote({
  count,
  onShowAll,
}: {
  count: number;
  onShowAll: () => void;
}) {
  return (
    <button
      onClick={onShowAll}
      className="flex w-full items-center gap-1 border-b border-dashed border-border px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      {count} file{count === 1 ? "" : "s"} from earlier turns hidden —{" "}
      <span className="text-primary">show all changes</span>
    </button>
  );
}

function DiffFile({
  file,
  diff,
  view,
  viewed,
  open,
  inLastTurn,
  commentCount,
  commenting,
  onToggleOpen,
  onToggleViewed,
  onDiscard,
}: {
  file: FileChange;
  diff: string;
  view: ViewKind;
  viewed: boolean;
  open: boolean;
  inLastTurn: boolean;
  commentCount: number;
  commenting: DiffCommenting;
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
        {inLastTurn && (
          <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            last turn
          </span>
        )}
        {commentCount > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-warning">
            <MessageSquare className="size-3" /> {commentCount}
          </span>
        )}
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
          <UnifiedDiff hunks={hunks} commenting={commenting} />
        ) : (
          <SplitDiff hunks={hunks} commenting={commenting} />
        ))}
    </div>
  );
}
