import { describe, expect, it } from "vitest";
import {
  displayText,
  encodeTypedDisplay,
  parseTypedDisplay,
  plural,
  type TypedDisplay,
} from "./chatDisplay";

const review: TypedDisplay = {
  $kind: "review",
  v: 1,
  comments: [
    { file: "src/a.ts", line: 1, text: "one" },
    { file: "src/a.ts", line: 9, text: "two" },
    { file: "src/b.ts", line: 4, text: "three" },
  ],
};

describe("encode / parse round-trip", () => {
  it("round-trips a review payload", () => {
    expect(parseTypedDisplay(encodeTypedDisplay(review))).toEqual(review);
  });

  it("round-trips an empty comment list", () => {
    const empty: TypedDisplay = { $kind: "review", v: 1, comments: [] };
    expect(parseTypedDisplay(encodeTypedDisplay(empty))).toEqual(empty);
  });

  it("preserves text that itself looks like JSON", () => {
    const tricky: TypedDisplay = {
      $kind: "review",
      v: 1,
      comments: [{ file: "a", line: 1, text: '{"$kind":"review"}' }],
    };
    expect(parseTypedDisplay(encodeTypedDisplay(tricky))).toEqual(tricky);
  });
});

describe("parseTypedDisplay — plain text stays plain", () => {
  it("returns null for ordinary messages", () => {
    for (const s of [
      "hello",
      "",
      "{}",
      '{"kind":"review"}',
      "  " + JSON.stringify(review), // the sniff is anchored at index 0
      JSON.stringify(review).slice(1),
      "```json\n" + JSON.stringify(review) + "\n```",
    ])
      expect(parseTypedDisplay(s)).toBeNull();
  });

  it("returns null for malformed JSON that passes the sniff", () => {
    expect(parseTypedDisplay('{"$kind":"review", comments')).toBeNull();
  });
});

describe("parseTypedDisplay — validation", () => {
  const bad = [
    ["unknown kind", { $kind: "plan", v: 1, comments: [] }],
    ["comments missing", { $kind: "review", v: 1 }],
    ["comments not an array", { $kind: "review", v: 1, comments: {} }],
    ["comments null", { $kind: "review", v: 1, comments: null }],
    ["null comment", { $kind: "review", v: 1, comments: [null] }],
    [
      "file missing",
      { $kind: "review", v: 1, comments: [{ line: 1, text: "t" }] },
    ],
    [
      "line as a string",
      {
        $kind: "review",
        v: 1,
        comments: [{ file: "a", line: "1", text: "t" }],
      },
    ],
    [
      "text missing",
      { $kind: "review", v: 1, comments: [{ file: "a", line: 1 }] },
    ],
    [
      "one bad comment among good ones",
      {
        $kind: "review",
        v: 1,
        comments: [{ file: "a", line: 1, text: "t" }, { file: "b" }],
      },
    ],
  ] as const;

  for (const [name, payload] of bad) {
    it(`rejects ${name}`, () => {
      // `$kind` is the first key, so these all pass the `{"$kind"` sniff and
      // it is validation — not the prefix check — that rejects them.
      const json = JSON.stringify(payload);
      expect(json.startsWith('{"$kind"')).toBe(true);
      expect(parseTypedDisplay(json)).toBeNull();
    });
  }

  it("normalizes the version to 1", () => {
    const parsed = parseTypedDisplay(
      JSON.stringify({ $kind: "review", v: 99, comments: [] }),
    );
    expect(parsed?.v).toBe(1);
  });
});

describe("plural", () => {
  it("switches on 1", () => {
    expect(plural(0, "comment")).toBe("0 comments");
    expect(plural(1, "comment")).toBe("1 comment");
    expect(plural(2, "comment")).toBe("2 comments");
  });
});

describe("displayText", () => {
  it("passes plain messages through untouched", () => {
    expect(displayText("just a message")).toBe("just a message");
    expect(displayText("")).toBe("");
  });

  it("summarizes a review payload by comments and distinct files", () => {
    expect(displayText(encodeTypedDisplay(review))).toBe(
      "Review feedback · 3 comments on 2 files",
    );
  });

  it("singularizes both counts", () => {
    const one = encodeTypedDisplay({
      $kind: "review",
      v: 1,
      comments: [{ file: "a.ts", line: 1, text: "x" }],
    });
    expect(displayText(one)).toBe("Review feedback · 1 comment on 1 file");
  });

  it("never leaks raw JSON for a malformed typed payload", () => {
    // Invalid payloads fall back to the raw string — the one place JSON can
    // still reach a label. Pinned so a future validation change is noticed.
    const broken = '{"$kind":"review","v":1,"comments":[{"file":1}]}';
    expect(displayText(broken)).toBe(broken);
  });
});
