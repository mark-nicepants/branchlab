import { describe, expect, it } from "vitest";
import {
  buildReviewMessage,
  editedInTurn,
  fileName,
  turnFilePaths,
  type ReviewComment,
} from "./review";
import { parseTypedDisplay } from "./chatDisplay";

describe("fileName", () => {
  it("takes the last segment", () => {
    expect(fileName("src/lib/review.ts")).toBe("review.ts");
    expect(fileName("/abs/src/review.ts")).toBe("review.ts");
    expect(fileName("review.ts")).toBe("review.ts");
    expect(fileName("")).toBe("");
  });
});

describe("editedInTurn", () => {
  it("matches an exact repo-relative path", () => {
    expect(editedInTurn("src/foo.ts", ["src/foo.ts"])).toBe(true);
    expect(editedInTurn("src/foo.ts", ["src/bar.ts"])).toBe(false);
    expect(editedInTurn("src/foo.ts", [])).toBe(false);
  });

  it("matches an absolute turn path against a repo-relative change", () => {
    // The turn summary carries absolute paths; git changes are repo-relative.
    expect(editedInTurn("src/foo.ts", ["/Users/me/repo/src/foo.ts"])).toBe(
      true,
    );
    expect(editedInTurn("foo.ts", ["/Users/me/repo/foo.ts"])).toBe(true);
  });

  it("does not match on a partial segment", () => {
    // The `/` anchor is what keeps these apart.
    expect(editedInTurn("foo.ts", ["/repo/src/myfoo.ts"])).toBe(false);
    expect(editedInTurn("lib/foo.ts", ["/repo/src/sublib/foo.ts"])).toBe(false);
    expect(editedInTurn("src/foo.ts", ["src/foo.tsx"])).toBe(false);
  });

  it("does not match the reverse direction", () => {
    // A turn that edited only `foo.ts` must not claim `src/foo.ts`.
    expect(editedInTurn("src/foo.ts", ["foo.ts"])).toBe(false);
  });

  it("KNOWN false positive: a deeper path with the same tail matches", () => {
    // The suffix test has no repo root to anchor against, so a turn touching
    // `vendor/src/foo.ts` also marks a changed `src/foo.ts` as edited. Pinned
    // rather than fixed: the correct anchor is the repo root, which this
    // function is not given.
    expect(editedInTurn("src/foo.ts", ["/repo/vendor/src/foo.ts"])).toBe(true);
    expect(editedInTurn("src/foo.ts", ["other/src/foo.ts"])).toBe(true);
  });
});

describe("turnFilePaths", () => {
  const files = [
    { path: "src/a.ts" },
    { path: "src/b.ts" },
    { path: "docs/c.md" },
  ];

  it("is empty with no last turn", () => {
    expect(turnFilePaths(files, null)).toEqual(new Set());
  });

  it("selects only the paths the turn touched", () => {
    const scoped = turnFilePaths(files, {
      files: ["/repo/src/a.ts", "docs/c.md"],
      label: "fix things",
    });
    expect([...scoped].sort()).toEqual(["docs/c.md", "src/a.ts"]);
  });

  it("is empty when the turn edited nothing that is still changed", () => {
    expect(
      turnFilePaths(files, { files: ["src/gone.ts"], label: null }),
    ).toEqual(new Set());
  });
});

describe("buildReviewMessage", () => {
  const comments: ReviewComment[] = [
    {
      id: "1",
      file: "src/a.ts",
      side: "new",
      line: 12,
      lineText: "  const x = 1;",
      text: "rename this",
    },
    {
      id: "2",
      file: "src/b.ts",
      side: "old",
      line: 3,
      lineText: "   ",
      text: "why removed?",
    },
  ];

  it("round-trips display through the typed-display parser", () => {
    const { display } = buildReviewMessage(comments);
    expect(parseTypedDisplay(display)).toEqual({
      $kind: "review",
      v: 1,
      comments: [
        { file: "src/a.ts", line: 12, text: "rename this" },
        { file: "src/b.ts", line: 3, text: "why removed?" },
      ],
    });
  });

  it("gives the agent file, line, side and exact line content", () => {
    const { sent } = buildReviewMessage(comments);
    expect(sent).toContain("2 inline comments");
    expect(sent).toContain("1. src/a.ts, line 12 (new side)");
    expect(sent).toContain("Line content: const x = 1;");
    expect(sent).toContain("2. src/b.ts, line 3 (removed/old side)");
    // A whitespace-only diff line is labeled, not sent blank.
    expect(sent).toContain("Line content: (blank line)");
  });

  it("singularizes a lone comment", () => {
    expect(buildReviewMessage([comments[0]]).sent).toContain(
      "1 inline comment.",
    );
  });
});
