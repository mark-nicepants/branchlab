import { describe, expect, it } from "vitest";
import { parseDiff, splitRows } from "./diff";

const SAMPLE = `diff --git a/foo.txt b/foo.txt
index 0000000..1111111 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,3 @@
 context line
-removed line
+added line
 last line`;

describe("parseDiff", () => {
  it("parses a single hunk with correct line types", () => {
    const hunks = parseDiff(SAMPLE);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.map((l) => l.type)).toEqual([
      "context",
      "del",
      "add",
      "context",
    ]);
  });

  it("strips the leading marker from line text", () => {
    const [hunk] = parseDiff(SAMPLE);
    expect(hunk.lines[1].text).toBe("removed line");
    expect(hunk.lines[2].text).toBe("added line");
    expect(hunk.lines[0].text).toBe("context line");
  });

  it("assigns old/new line numbers from the hunk header", () => {
    const [hunk] = parseDiff(SAMPLE);
    expect(hunk.lines[0]).toMatchObject({ oldNo: 1, newNo: 1 });
    expect(hunk.lines[1]).toMatchObject({ oldNo: 2, newNo: null }); // del
    expect(hunk.lines[2]).toMatchObject({ oldNo: null, newNo: 2 }); // add
    expect(hunk.lines[3]).toMatchObject({ oldNo: 3, newNo: 3 });
  });

  it("ignores file headers before the first hunk", () => {
    // The +++/--- lines must not become diff lines.
    const texts = parseDiff(SAMPLE).flatMap((h) => h.lines.map((l) => l.text));
    expect(texts.some((t) => t.startsWith("a/") || t.startsWith("b/"))).toBe(false);
  });

  it("returns no hunks for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });

  it("handles multiple hunks", () => {
    const diff = `@@ -1 +1 @@
-a
+b
@@ -10 +10 @@
-c
+d`;
    expect(parseDiff(diff)).toHaveLength(2);
  });
});

describe("splitRows", () => {
  it("pairs deletions on the left with additions on the right", () => {
    const [hunk] = parseDiff(SAMPLE);
    const rows = splitRows(hunk);
    // context, then a del/add pair, then context.
    expect(rows).toHaveLength(3);
    expect(rows[1].left?.type).toBe("del");
    expect(rows[1].right?.type).toBe("add");
  });

  it("leaves the missing side null when del/add counts differ", () => {
    const hunk = parseDiff(`@@ -1,1 +1,2 @@
-only removed
+new one
+new two`)[0];
    const rows = splitRows(hunk);
    expect(rows[0]).toMatchObject({ left: { type: "del" }, right: { type: "add" } });
    expect(rows[1].left).toBeNull();
    expect(rows[1].right?.type).toBe("add");
  });
});
