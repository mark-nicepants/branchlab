// Shared unified/split renderers for parsed diff hunks. Used by the Changes
// tab (full file diffs from git) and by the chat (edit/write tool previews).

import { splitRows, type DiffHunk, type DiffLineType } from "@/lib/diff";
import { cn } from "@/lib/utils";

const GUTTER = "w-10 shrink-0 select-none px-1 text-right text-muted-foreground/50";
const CODE = "min-w-0 flex-1 select-text whitespace-pre-wrap break-words px-1";

function bgFor(type: DiffLineType): string {
  if (type === "add") return "bg-additions/10";
  if (type === "del") return "bg-deletions/10";
  return "";
}

const sign = (t: DiffLineType) => (t === "add" ? "+" : t === "del" ? "−" : " ");

export function UnifiedDiff({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="font-mono text-[12px] leading-[1.5]">
      {hunks.map((h, i) => (
        <div key={i}>
          <div className="bg-muted/40 px-2 py-0.5 text-info">{h.header}</div>
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

export function SplitDiff({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="font-mono text-[12px] leading-[1.5]">
      {hunks.map((h, i) => (
        <div key={i}>
          <div className="bg-muted/40 px-2 py-0.5 text-info">{h.header}</div>
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
