// Inline review comments on the Changes view: pending-comment model plus the
// chat message built from them (clean display text, full context for the AI).

export interface ReviewComment {
  id: string;
  /** Repo-relative path of the file the comment is on. */
  file: string;
  /** Which side of the diff the line belongs to. */
  side: "old" | "new";
  /** 1-based line number on that side. */
  line: number;
  /** The diff line's content, captured so the AI gets exact context. */
  lineText: string;
  text: string;
}

export type NewReviewComment = Omit<ReviewComment, "id">;

/** Last path segment, for compact `name:line` labels. */
export function fileName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Whether a changed file was edited in the given turn's file list. The turn
 *  summary may carry absolute paths while git changes are repo-relative, so
 *  match exact or by suffix. */
export function editedInTurn(path: string, turnFiles: string[]): boolean {
  return turnFiles.some((f) => f === path || f.endsWith(`/${path}`));
}

/** The most recent assistant turn, for "Last turn" scoping. */
export interface LastTurnInfo {
  /** Files the turn edited (from the turn's collapse summary). */
  files: string[];
  /** The user prompt that started the turn, for the scope label. */
  label: string | null;
}

/** Which changes the panel shows: the last AI turn's files, or everything. */
export type ChangeScope = "turn" | "all";

/** Changed-file paths that belong to the last turn. */
export function turnFilePaths(
  files: { path: string }[],
  lastTurn: LastTurnInfo | null,
): Set<string> {
  if (!lastTurn) return new Set();
  return new Set(
    files
      .filter((f) => editedInTurn(f.path, lastTurn.files))
      .map((f) => f.path),
  );
}

const DISPLAY_SNIPPET = 96;

/**
 * Build the chat message for a batch of review comments: `display` is the
 * clean summary shown in the transcript; `sent` carries every comment with
 * file, line, side and the exact line content so the agent can iterate
 * without re-locating anything.
 */
export function buildReviewMessage(comments: ReviewComment[]): {
  display: string;
  sent: string;
} {
  const files = new Set(comments.map((c) => c.file)).size;
  const n = comments.length;
  const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;

  const display = [
    `Review feedback · ${plural(n, "comment")} on ${plural(files, "file")}`,
    ...comments.map((c) => {
      const snippet =
        c.text.length > DISPLAY_SNIPPET
          ? `${c.text.slice(0, DISPLAY_SNIPPET)}…`
          : c.text;
      return `• ${fileName(c.file)}:${c.line} — ${snippet}`;
    }),
  ].join("\n");

  const sent = [
    `I reviewed your latest changes in the diff view and left ${plural(n, "inline comment")}. Address each one, then briefly summarize what you changed.`,
    "",
    ...comments.map((c, i) =>
      [
        `${i + 1}. ${c.file}, line ${c.line} (${c.side === "old" ? "removed/old" : "new"} side)`,
        `   Line content: ${c.lineText.trim() || "(blank line)"}`,
        `   Comment: ${c.text}`,
      ].join("\n"),
    ),
  ].join("\n");

  return { display, sent };
}
