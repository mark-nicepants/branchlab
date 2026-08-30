import { describe, expect, it } from "vitest";
import {
  Bot,
  FileText,
  Globe,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import {
  describeTool,
  diffStats,
  fmtDuration,
  toolOutcome,
} from "./toolDisplay";
import type { ToolBlock } from "./types";

function tool(over: Partial<ToolBlock> = {}): ToolBlock {
  return {
    blockId: "b1",
    callId: "c1",
    name: "read",
    title: null,
    status: "completed",
    input: {},
    output: null,
    diff: null,
    ...over,
  };
}

describe("describeTool — known kinds", () => {
  const cases: [
    string,
    unknown,
    { verb: string; obj: string; kind: string },
  ][] = [
    [
      "read",
      { filePath: "src/a.ts" },
      { verb: "Read", obj: "src/a.ts", kind: "read" },
    ],
    [
      "edit",
      { filePath: "src/a.ts" },
      { verb: "Edited", obj: "src/a.ts", kind: "edit" },
    ],
    [
      "multiedit",
      { file: "src/a.ts" },
      { verb: "Edited", obj: "src/a.ts", kind: "edit" },
    ],
    [
      "patch",
      { path: "src/a.ts" },
      { verb: "Edited", obj: "src/a.ts", kind: "edit" },
    ],
    [
      "write",
      { filePath: "n.md" },
      { verb: "Wrote", obj: "n.md", kind: "edit" },
    ],
    [
      "bash",
      { command: "ls -la" },
      { verb: "Ran", obj: "ls -la", kind: "execute" },
    ],
    ["shell", { cmd: "pwd" }, { verb: "Ran", obj: "pwd", kind: "execute" }],
    ["run", { command: "make" }, { verb: "Ran", obj: "make", kind: "execute" }],
    [
      "execute",
      { command: "make" },
      { verb: "Ran", obj: "make", kind: "execute" },
    ],
    [
      "grep",
      { pattern: "TODO" },
      { verb: "Searched", obj: "TODO", kind: "search" },
    ],
    [
      "search",
      { query: "TODO" },
      { verb: "Searched", obj: "TODO", kind: "search" },
    ],
    [
      "glob",
      { glob: "**/*.ts" },
      { verb: "Searched", obj: "**/*.ts", kind: "search" },
    ],
    ["rg", { pattern: "x" }, { verb: "Searched", obj: "x", kind: "search" }],
    ["ls", { path: "src" }, { verb: "Listed", obj: "src", kind: "search" }],
    ["list", { path: "src" }, { verb: "Listed", obj: "src", kind: "search" }],
    [
      "fetch",
      { url: "https://x.dev" },
      { verb: "Fetched", obj: "https://x.dev", kind: "fetch" },
    ],
    [
      "webfetch",
      { url: "https://x.dev" },
      { verb: "Fetched", obj: "https://x.dev", kind: "fetch" },
    ],
    [
      "task",
      { description: "audit" },
      { verb: "Subagent", obj: "audit", kind: "task" },
    ],
    ["agent", { prompt: "go" }, { verb: "Subagent", obj: "go", kind: "task" }],
    [
      "subagent",
      { prompt: "go" },
      { verb: "Subagent", obj: "go", kind: "task" },
    ],
    [
      "delete",
      { path: "old.ts" },
      { verb: "Deleted", obj: "old.ts", kind: "other" },
    ],
    [
      "rm",
      { path: "old.ts" },
      { verb: "Deleted", obj: "old.ts", kind: "other" },
    ],
    [
      "move",
      { path: "old.ts" },
      { verb: "Moved", obj: "old.ts", kind: "other" },
    ],
    ["mv", { path: "old.ts" }, { verb: "Moved", obj: "old.ts", kind: "other" }],
  ];

  for (const [name, input, expected] of cases) {
    it(`maps ${name}`, () => {
      const { verb, obj, kind } = describeTool(tool({ name, input }));
      expect({ verb, obj, kind }).toEqual(expected);
    });
  }

  it("picks the right glyph per family", () => {
    const icon = (name: string, input: unknown = {}) =>
      describeTool(tool({ name, input })).Icon;
    expect(icon("read")).toBe(FileText);
    expect(icon("edit")).toBe(Pencil);
    expect(icon("bash")).toBe(Terminal);
    expect(icon("grep")).toBe(Search);
    expect(icon("fetch")).toBe(Globe);
    expect(icon("task")).toBe(Bot);
    expect(icon("some-mcp-tool")).toBe(Wrench);
  });
});

describe("describeTool — the never-crash contract", () => {
  it("falls back to a capitalized generic row for an unknown kind", () => {
    const d = describeTool(
      tool({ name: "notion_search", title: "Search Notion" }),
    );
    expect(d).toMatchObject({
      Icon: Wrench,
      verb: "Notion_search",
      obj: "Search Notion",
      kind: "other",
    });
  });

  it("survives an empty tool name", () => {
    expect(describeTool(tool({ name: "" }))).toMatchObject({
      verb: "",
      obj: "",
      kind: "other",
    });
  });

  it("falls back to the title when the expected input field is missing", () => {
    expect(
      describeTool(tool({ name: "read", input: {}, title: "a.ts" })).obj,
    ).toBe("a.ts");
    expect(
      describeTool(tool({ name: "bash", input: {}, title: "ls" })).obj,
    ).toBe("ls");
    expect(
      describeTool(tool({ name: "grep", input: {}, title: "hits" })).obj,
    ).toBe("hits");
  });

  it("yields an empty object when both input and title are missing", () => {
    expect(
      describeTool(tool({ name: "read", input: null, title: null })).obj,
    ).toBe("");
  });

  it("ignores non-string input fields instead of rendering them", () => {
    // The wire type is `unknown`; a number/object where a path was expected
    // must degrade to the title, not stringify into the row.
    expect(
      describeTool(tool({ name: "read", input: { filePath: 42 }, title: "t" }))
        .obj,
    ).toBe("t");
    expect(
      describeTool(
        tool({ name: "bash", input: { command: { a: 1 } }, title: "t" }),
      ).obj,
    ).toBe("t");
  });

  it("survives a non-object input entirely", () => {
    for (const input of [undefined, null, "raw string", 7, [], true])
      expect(() => describeTool(tool({ name: "read", input }))).not.toThrow();
    expect(
      describeTool(tool({ name: "read", input: "raw", title: "t" })).obj,
    ).toBe("t");
  });

  it("prefers filePath, then file, then path", () => {
    const obj = (input: unknown) =>
      describeTool(tool({ name: "read", input })).obj;
    expect(obj({ filePath: "a", file: "b", path: "c" })).toBe("a");
    expect(obj({ file: "b", path: "c" })).toBe("b");
    expect(obj({ path: "c" })).toBe("c");
  });
});

describe("toolOutcome", () => {
  it("reports +/- for an edit with a diff", () => {
    const block = tool({
      name: "edit",
      diff: { path: "a.ts", oldText: "one\ntwo", newText: "one\ntwo\nthree" },
    });
    expect(toolOutcome(block, "edit")).toEqual({
      type: "diff",
      add: 3,
      del: 2,
    });
  });

  it("reports nothing for an edit with no diff attached", () => {
    expect(toolOutcome(tool({ name: "edit" }), "edit")).toBeNull();
  });

  it("counts non-blank result lines for a search", () => {
    const block = tool({ name: "grep", output: "a.ts:1\n\n  \nb.ts:2\n" });
    expect(toolOutcome(block, "search")).toEqual({ type: "results", count: 2 });
  });

  it("reports zero results for empty search output", () => {
    expect(toolOutcome(tool({ name: "grep", output: "" }), "search")).toEqual({
      type: "results",
      count: 0,
    });
  });

  it("reports nothing when a search has no output at all", () => {
    expect(
      toolOutcome(tool({ name: "grep", output: null }), "search"),
    ).toBeNull();
  });

  it("reports the first located line for a read", () => {
    const block = tool({
      name: "read",
      locations: [
        { path: "a.ts", line: null },
        { path: "a.ts", line: 42 },
      ],
    });
    expect(toolOutcome(block, "read")).toEqual({ type: "line", line: 42 });
  });

  it("reports nothing for a read with absent or line-less locations", () => {
    expect(toolOutcome(tool({ name: "read" }), "read")).toBeNull();
    expect(
      toolOutcome(
        tool({ name: "read", locations: [{ path: "a", line: null }] }),
        "read",
      ),
    ).toBeNull();
  });

  it("reports nothing for kinds with no outcome slot", () => {
    for (const kind of ["execute", "fetch", "task", "other"] as const)
      expect(
        toolOutcome(tool({ name: "x", output: "noise" }), kind),
      ).toBeNull();
  });
});

describe("diffStats", () => {
  it("counts a whole-file replacement", () => {
    expect(
      diffStats({ path: "a", oldText: "a\nb", newText: "x\ny\nz" }),
    ).toEqual({
      add: 3,
      del: 2,
    });
  });

  it("treats a null oldText as a new file", () => {
    expect(diffStats({ path: "a", oldText: null, newText: "x\ny" })).toEqual({
      add: 2,
      del: 0,
    });
  });

  it("treats an empty newText as a full delete", () => {
    expect(diffStats({ path: "a", oldText: "x\ny", newText: "" })).toEqual({
      add: 0,
      del: 2,
    });
  });

  it("handles both sides empty", () => {
    expect(diffStats({ path: "a", oldText: "", newText: "" })).toEqual({
      add: 0,
      del: 0,
    });
  });

  it("counts content lines that start with --- / +++", () => {
    // YAML separators and markdown rules: the old `+++`/`---` prefix guard
    // (meant for real unified-diff file headers) silently dropped these.
    expect(
      diffStats({
        path: "a.md",
        oldText: "---\ntitle: x",
        newText: "+++\na\n---",
      }),
    ).toEqual({
      add: 3,
      del: 2,
    });
  });
});

describe("fmtDuration", () => {
  it("hides sub-50ms durations", () => {
    expect(fmtDuration(0)).toBe("");
    expect(fmtDuration(49)).toBe("");
    expect(fmtDuration(-10)).toBe("");
  });

  it("shows one decimal below 10s", () => {
    expect(fmtDuration(50)).toBe("0.1s");
    expect(fmtDuration(1500)).toBe("1.5s");
    expect(fmtDuration(9949)).toBe("9.9s");
  });

  it("rounds to whole seconds from 10s to a minute", () => {
    expect(fmtDuration(10_000)).toBe("10s");
    expect(fmtDuration(59_400)).toBe("59s");
  });

  it("switches to m/s at a minute", () => {
    expect(fmtDuration(60_000)).toBe("1m 0s");
    expect(fmtDuration(95_000)).toBe("1m 35s");
    expect(fmtDuration(3_600_000)).toBe("60m 0s");
    expect(fmtDuration(86_400_000)).toBe("1440m 0s");
  });
});
