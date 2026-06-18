// Minimal unified-diff parser → structured hunks with old/new line numbers,
// used by both the unified and split diff renderers.

export type DiffLineType = "context" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

const HUNK_RE = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of diff.split("\n")) {
    const m = HUNK_RE.exec(raw);
    if (raw.startsWith("@@") && m) {
      oldNo = parseInt(m[1], 10);
      newNo = parseInt(m[2], 10);
      cur = { header: raw, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // skip file headers before the first hunk
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"

    if (raw.startsWith("+")) {
      cur.lines.push({ type: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      cur.lines.push({ type: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) });
    } else {
      const text = raw.startsWith(" ") ? raw.slice(1) : raw;
      cur.lines.push({ type: "context", oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  return hunks;
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Pair a hunk's lines into side-by-side rows (dels left, adds right). */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];

  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };

  for (const line of hunk.lines) {
    if (line.type === "del") dels.push(line);
    else if (line.type === "add") adds.push(line);
    else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}

/**
 * Build a synthetic unified-diff string from raw old/new text. Used as a
 * fallback when a tool's metadata.diff isn't available yet (e.g. while the
 * edit is still running) so the chat can still show something useful.
 */
export function synthesizeDiff(oldText: string, newText: string): string {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  const header = `@@ -1,${oldLines.length} +1,${newLines.length} @@`;
  const parts = [header];
  if (oldLines.length) parts.push(oldLines.map((l) => `-${l}`).join("\n"));
  if (newLines.length) parts.push(newLines.map((l) => `+${l}`).join("\n"));
  return parts.join("\n");
}
