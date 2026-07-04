// Shared unified/split renderers for parsed diff hunks. Used by the Changes
// tab (full file diffs from git) and by the chat (edit/write tool previews).
// Optional `commenting` enables PR-style inline review comments on lines.

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { splitRows, type DiffHunk, type DiffLine, type DiffLineType } from "@/lib/diff";
import type { NewReviewComment, ReviewComment } from "@/lib/review";
import { fileName } from "@/lib/review";
import { Kbd } from "./Composer";
import { cn } from "@/lib/utils";

const GUTTER =
  "w-10 shrink-0 select-none px-1 text-right text-muted-foreground/50";
const CODE = "min-w-0 flex-1 select-text whitespace-pre-wrap break-words px-1";

function bgFor(type: DiffLineType): string {
  if (type === "add") return "bg-additions/10";
  if (type === "del") return "bg-deletions/10";
  return "";
}

const sign = (t: DiffLineType) => (t === "add" ? "+" : t === "del" ? "−" : " ");

/** Wiring for inline review comments; absent → plain read-only diff. */
export interface DiffCommenting {
  /** Repo-relative path of the file this diff renders. */
  file: string;
  comments: ReviewComment[];
  onAdd: (comment: NewReviewComment) => void;
  onRemove: (id: string) => void;
}

/** The (side, line) a diff line anchors comments to. Deleted lines live on the
 *  old side; added and context lines on the new side. */
interface Anchor {
  side: "old" | "new";
  line: number;
}

function anchorOf(l: DiffLine): Anchor | null {
  if (l.type === "del") return l.oldNo != null ? { side: "old", line: l.oldNo } : null;
  return l.newNo != null ? { side: "new", line: l.newNo } : null;
}

const sameAnchor = (a: Anchor | null, b: Anchor | null) =>
  !!a && !!b && a.side === b.side && a.line === b.line;

/** Row-click handler that opens the composer — but never while the user is
 *  selecting code, so copy/select gestures don't pop a comment box. */
const clickToCompose = (compose: () => void) => () => {
  if (window.getSelection()?.toString()) return;
  compose();
};

export function UnifiedDiff({
  hunks,
  commenting,
}: {
  hunks: DiffHunk[];
  commenting?: DiffCommenting;
}) {
  const [composing, setComposing] = useState<Anchor | null>(null);

  return (
    <div className="font-mono text-[12px] leading-[1.5]">
      {hunks.map((h, i) => (
        <div key={i}>
          <div className="bg-muted/40 px-2 py-0.5 text-info">{h.header}</div>
          {h.lines.map((l, j) => {
            const anchor = commenting ? anchorOf(l) : null;
            const rowComments =
              commenting && anchor
                ? commenting.comments.filter(
                    (c) => c.side === anchor.side && c.line === anchor.line,
                  )
                : [];
            const isComposing = sameAnchor(composing, anchor);
            return (
              <div key={j}>
                <div
                  className={cn(
                    "group relative flex",
                    bgFor(l.type),
                    commenting && anchor && "cursor-pointer",
                    rowComments.length > 0 && "shadow-[inset_2px_0_0] shadow-warning",
                  )}
                  onClick={
                    commenting && anchor
                      ? clickToCompose(() => setComposing(anchor))
                      : undefined
                  }
                >
                  <span className={GUTTER}>{l.oldNo ?? ""}</span>
                  <span className={GUTTER}>{l.newNo ?? ""}</span>
                  <span className="w-4 shrink-0 select-none text-center text-muted-foreground/60">
                    {sign(l.type)}
                  </span>
                  <span className={CODE}>{l.text || " "}</span>
                  {commenting && anchor && (
                    <AddCommentButton onClick={() => setComposing(anchor)} />
                  )}
                </div>
                {commenting && anchor && (rowComments.length > 0 || isComposing) && (
                  <CommentThread
                    file={commenting.file}
                    line={anchor.line}
                    comments={rowComments}
                    onRemove={commenting.onRemove}
                    composing={isComposing}
                    onSubmit={(text) => {
                      commenting.onAdd({
                        file: commenting.file,
                        side: anchor.side,
                        line: anchor.line,
                        lineText: l.text,
                        text,
                      });
                      setComposing(null);
                    }}
                    onCancel={() => setComposing(null)}
                    onCompose={() => setComposing(anchor)}
                  />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function SplitDiff({
  hunks,
  commenting,
}: {
  hunks: DiffHunk[];
  commenting?: DiffCommenting;
}) {
  const [composing, setComposing] = useState<Anchor | null>(null);

  return (
    <div className="font-mono text-[12px] leading-[1.5]">
      {hunks.map((h, i) => (
        <div key={i}>
          <div className="bg-muted/40 px-2 py-0.5 text-info">{h.header}</div>
          {splitRows(h).map((r, j) => {
            const leftAnchor = commenting && r.left ? anchorOf(r.left) : null;
            const rightAnchor = commenting && r.right ? anchorOf(r.right) : null;
            // A context row yields the same anchor on both sides — keep one.
            const anchors = sameAnchor(leftAnchor, rightAnchor)
              ? [leftAnchor]
              : [leftAnchor, rightAnchor];
            const rowComments = commenting
              ? commenting.comments.filter((c) =>
                  anchors.some((a) => a && c.side === a.side && c.line === a.line),
                )
              : [];
            const composingAnchor = anchors.find((a) => sameAnchor(composing, a));
            const composeLine = composingAnchor
              ? composingAnchor === leftAnchor
                ? r.left
                : r.right
              : null;
            return (
              <div key={j}>
                <div
                  className={cn(
                    "flex",
                    rowComments.length > 0 && "shadow-[inset_2px_0_0] shadow-warning",
                  )}
                >
                  <SplitSide
                    line={r.left}
                    which="old"
                    onCompose={leftAnchor ? () => setComposing(leftAnchor) : undefined}
                  />
                  <span className="w-px shrink-0 bg-border" />
                  <SplitSide
                    line={r.right}
                    which="new"
                    onCompose={rightAnchor ? () => setComposing(rightAnchor) : undefined}
                  />
                </div>
                {commenting &&
                  (rowComments.length > 0 || (composingAnchor && composeLine)) && (
                    <CommentThread
                      file={commenting.file}
                      line={(composingAnchor ?? anchors.find(Boolean))!.line}
                      comments={rowComments}
                      onRemove={commenting.onRemove}
                      composing={!!composingAnchor}
                      onSubmit={(text) => {
                        if (!composingAnchor || !composeLine) return;
                        commenting.onAdd({
                          file: commenting.file,
                          side: composingAnchor.side,
                          line: composingAnchor.line,
                          lineText: composeLine.text,
                          text,
                        });
                        setComposing(null);
                      }}
                      onCancel={() => setComposing(null)}
                      onCompose={() => {
                        const a = rightAnchor ?? leftAnchor;
                        if (a) setComposing(a);
                      }}
                    />
                  )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SplitSide({
  line,
  which,
  onCompose,
}: {
  line: DiffLine | null;
  which: "old" | "new";
  onCompose?: () => void;
}) {
  if (!line) return <div className="flex-1 bg-muted/20" />;
  const no = which === "old" ? line.oldNo : line.newNo;
  // Only the side a line anchors to is clickable (dels left, adds/context right).
  const anchorable =
    onCompose && (line.type === "del" ? which === "old" : which === "new");
  return (
    <div
      className={cn(
        "group relative flex min-w-0 flex-1",
        bgFor(line.type),
        anchorable && "cursor-pointer",
      )}
      onClick={anchorable ? clickToCompose(onCompose) : undefined}
    >
      <span className={GUTTER}>{no ?? ""}</span>
      <span className={CODE}>{line.text || " "}</span>
      {anchorable && <AddCommentButton onClick={onCompose} />}
    </div>
  );
}

/** Hover-revealed `+` in the gutter, GitHub-style. */
function AddCommentButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Comment on this line"
      className="absolute left-0.5 top-1/2 hidden size-4 -translate-y-1/2 items-center justify-center rounded bg-primary text-primary-foreground group-hover:flex"
    >
      <Plus className="size-3" />
    </button>
  );
}

/** Pending comment cards + optional composer, pinned under a diff line. */
function CommentThread({
  file,
  line,
  comments,
  onRemove,
  composing,
  onSubmit,
  onCancel,
  onCompose,
}: {
  file: string;
  line: number;
  comments: ReviewComment[];
  onRemove: (id: string) => void;
  composing: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onCompose: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-y border-border bg-primary/[0.04] py-2 pl-[58px] pr-3 font-sans">
      {comments.map((c) => (
        <div
          key={c.id}
          className="relative flex max-w-xl items-start gap-2 overflow-hidden rounded-md border border-border bg-card py-1.5 pl-3 pr-2.5"
        >
          {/* Amber "pending" rail: clipped to the card's rounding on the
              outside, straight on the inside. */}
          <span className="absolute inset-y-0 left-0 w-[3px] bg-warning" />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-muted-foreground">
              You · {fileName(c.file)}:{c.line} · pending
            </div>
            <div className="whitespace-pre-wrap text-xs">{c.text}</div>
          </div>
          <button
            className="shrink-0 text-muted-foreground hover:text-deletions"
            title="Delete comment"
            onClick={() => onRemove(c.id)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      {composing ? (
        <CommentComposer onSubmit={onSubmit} onCancel={onCancel} />
      ) : (
        comments.length > 0 && (
          <button
            onClick={onCompose}
            className="self-start text-[11px] text-muted-foreground hover:text-foreground"
          >
            + Add another comment on {fileName(file)}:{line}
          </button>
        )
      )}
    </div>
  );
}

function CommentComposer({
  onSubmit,
  onCancel,
}: {
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);

  return (
    <div className="flex max-w-xl flex-col gap-1">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (text.trim()) onSubmit(text.trim());
          }
        }}
        placeholder="Leave a comment for the agent…"
        className="min-h-[52px] w-full resize-y rounded-md border border-primary bg-card px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground"
      />
      <span className="text-[11px] text-muted-foreground/70">
        <Kbd>Enter</Kbd> to add · <Kbd>Shift</Kbd> <Kbd>Enter</Kbd> for newline
        · <Kbd>Esc</Kbd> to cancel
      </span>
    </div>
  );
}
