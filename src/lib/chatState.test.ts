import { describe, expect, it } from "vitest";
import {
  applyChatEvent,
  chatBusy,
  chatEntries,
  EMPTY_CHAT_STATE,
  type ChatState,
  type ChatStateEvent,
} from "./chatState";
import type { AssistantEntry, Block, Entry } from "./types";

// ── fixtures ──────────────────────────────────────────────────────────────

const summary = {
  collapsed: false,
  stepCount: 0,
  filesEdited: [],
  commandsRun: 0,
  headline: "",
};

function assistant(seq: number, over: Partial<AssistantEntry> = {}): Entry {
  return {
    type: "assistant",
    seq,
    entryId: `a${seq}`,
    status: "streaming",
    origin: "user",
    blocks: [],
    summary,
    usage: null,
    startedAt: 1000,
    endedAt: null,
    ...over,
  };
}

function user(seq: number, display = "hi"): Entry {
  return {
    type: "user",
    seq,
    entryId: `u${seq}`,
    display,
    sent: display,
    attachments: [],
    model: null,
    variant: null,
    agent: null,
    origin: "user",
    createdAt: 1000,
  };
}

const text = (blockId: string, t: string): Block => ({
  type: "text",
  blockId,
  text: t,
});

const turnEvent = (
  entrySeq: number,
  status: "streaming" | "completed" | "failed" | "cancelled",
  endedAt?: number | null,
): ChatStateEvent => ({
  kind: "turn",
  entrySeq,
  status,
  summary,
  usage: null,
  endedAt,
});

/** Fold a list of events, which is how the hook consumes them. */
const fold = (events: ChatStateEvent[], from: ChatState = EMPTY_CHAT_STATE) =>
  events.reduce(applyChatEvent, from);

const blocksOf = (s: ChatState, seq: number) =>
  (s.byId[seq] as AssistantEntry).blocks;

// ── entries ───────────────────────────────────────────────────────────────

describe("applyChatEvent — entries", () => {
  it("appends entries and keeps them in seq order", () => {
    const s = fold([
      { kind: "entry", entry: user(2) },
      { kind: "entry", entry: assistant(3) },
      { kind: "entry", entry: user(1) }, // out of order delivery
    ]);
    expect(s.order).toEqual([1, 2, 3]);
    expect(chatEntries(s).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("upserts by seq — a re-delivered entry replaces the earlier version", () => {
    const s = fold([
      { kind: "entry", entry: user(1, "draft") },
      { kind: "entry", entry: user(1, "final") },
    ]);
    expect(s.order).toEqual([1]);
    expect(chatEntries(s)).toHaveLength(1);
    expect((chatEntries(s)[0] as { display: string }).display).toBe("final");
  });

  it("is idempotent for a duplicated entry delivery", () => {
    const once = fold([{ kind: "entry", entry: assistant(1) }]);
    const twice = applyChatEvent(once, {
      kind: "entry",
      entry: assistant(1),
    });
    expect(twice.order).toEqual(once.order);
    // Same seq re-delivered: the order array is reused, not rebuilt.
    expect(twice.order).toBe(once.order);
  });
});

// ── blocks: the streaming path ────────────────────────────────────────────

describe("applyChatEvent — blocks", () => {
  const seeded = fold([{ kind: "entry", entry: assistant(1) }]);

  it("appends a new block", () => {
    const s = applyChatEvent(seeded, {
      kind: "block",
      entrySeq: 1,
      block: text("b1", "hello"),
    });
    expect(blocksOf(s, 1)).toEqual([text("b1", "hello")]);
  });

  it("upserts by blockId — duplicate delivery does not double the block", () => {
    const s = fold(
      [
        { kind: "block", entrySeq: 1, block: text("b1", "hel") },
        { kind: "block", entrySeq: 1, block: text("b1", "hello") },
        // exact duplicate of the last delivery (at-least-once transport)
        { kind: "block", entrySeq: 1, block: text("b1", "hello") },
      ],
      seeded,
    );
    expect(blocksOf(s, 1)).toEqual([text("b1", "hello")]);
  });

  it("streams full blocks, never appended deltas", () => {
    // Regression guard for 4d33ec0: each event carries the FULL block text.
    const s = fold(
      [
        { kind: "block", entrySeq: 1, block: text("b1", "The ") },
        { kind: "block", entrySeq: 1, block: text("b1", "The quick ") },
        { kind: "block", entrySeq: 1, block: text("b1", "The quick fox") },
      ],
      seeded,
    );
    expect(blocksOf(s, 1)).toEqual([text("b1", "The quick fox")]);
  });

  it("heals a dropped delivery — the next full block wins", () => {
    const s = fold(
      [{ kind: "block", entrySeq: 1, block: text("b1", "a b c") }],
      seeded,
    );
    expect(blocksOf(s, 1)[0]).toEqual(text("b1", "a b c"));
  });

  it("keeps first-seen block order when a later block arrives first", () => {
    // Reordered delivery: b2 lands before b1's first event. Both survive, in
    // arrival order — the reducer never reorders blocks, only upserts them.
    const s = fold(
      [
        { kind: "block", entrySeq: 1, block: text("b2", "second") },
        { kind: "block", entrySeq: 1, block: text("b1", "first") },
        { kind: "block", entrySeq: 1, block: text("b2", "second!") },
      ],
      seeded,
    );
    expect(blocksOf(s, 1).map((b) => b.blockId)).toEqual(["b2", "b1"]);
    expect(blocksOf(s, 1)[0]).toEqual(text("b2", "second!"));
  });

  it("drops a block for an unknown seq without crashing", () => {
    const s = applyChatEvent(seeded, {
      kind: "block",
      entrySeq: 99,
      block: text("b1", "orphan"),
    });
    expect(s).toBe(seeded);
    expect(s.byId[99]).toBeUndefined();
  });

  it("drops a block aimed at a non-assistant entry", () => {
    const withUser = fold([{ kind: "entry", entry: user(2) }], seeded);
    const s = applyChatEvent(withUser, {
      kind: "block",
      entrySeq: 2,
      block: text("b1", "nope"),
    });
    expect(s).toBe(withUser);
    expect(s.byId[2]).toEqual(user(2));
  });

  it("recovers once the missing entry finally arrives", () => {
    // Block for an unknown seq is dropped, but the backend re-emits: the
    // entry lands, then the next full block restores the text.
    const s = fold([
      { kind: "block", entrySeq: 5, block: text("b1", "lost") },
      { kind: "entry", entry: assistant(5) },
      { kind: "block", entrySeq: 5, block: text("b1", "lost") },
    ]);
    expect(blocksOf(s, 5)).toEqual([text("b1", "lost")]);
  });
});

// ── turn transitions ──────────────────────────────────────────────────────

describe("applyChatEvent — turns", () => {
  it("applies status, summary, usage and endedAt", () => {
    const s = fold([
      { kind: "entry", entry: assistant(1) },
      {
        kind: "turn",
        entrySeq: 1,
        status: "completed",
        summary: { ...summary, collapsed: true, headline: "Did the thing" },
        usage: { input: 10, output: 20 },
        endedAt: 2000,
      },
    ]);
    const e = s.byId[1] as AssistantEntry;
    expect(e.status).toBe("completed");
    expect(e.summary.headline).toBe("Did the thing");
    expect(e.usage).toEqual({ input: 10, output: 20 });
    expect(e.endedAt).toBe(2000);
  });

  it("keeps a known endedAt when a later transition omits it", () => {
    const s = fold([
      { kind: "entry", entry: assistant(1) },
      turnEvent(1, "completed", 2000),
      turnEvent(1, "completed"), // re-delivery without endedAt
    ]);
    expect((s.byId[1] as AssistantEntry).endedAt).toBe(2000);
  });

  it("drops a turn event arriving before its entry", () => {
    const s = fold([
      turnEvent(7, "completed", 2000),
      { kind: "entry", entry: assistant(7, { status: "streaming" }) },
    ]);
    // The early turn event is discarded; the entry's own status stands until
    // the backend re-emits the transition.
    expect(s.order).toEqual([7]);
    expect((s.byId[7] as AssistantEntry).status).toBe("streaming");
    expect(chatBusy(chatEntries(s))).toBe(true);

    const healed = applyChatEvent(s, turnEvent(7, "completed", 2000));
    expect((healed.byId[7] as AssistantEntry).status).toBe("completed");
    expect(chatBusy(chatEntries(healed))).toBe(false);
  });

  it("drops a turn event aimed at a non-assistant entry", () => {
    const before = fold([{ kind: "entry", entry: user(1) }]);
    expect(applyChatEvent(before, turnEvent(1, "completed"))).toBe(before);
  });

  it("is idempotent for a duplicated terminal transition", () => {
    const once = fold([
      { kind: "entry", entry: assistant(1) },
      turnEvent(1, "completed", 2000),
    ]);
    const twice = applyChatEvent(once, turnEvent(1, "completed", 2000));
    expect(twice.byId[1]).toEqual(once.byId[1]);
  });
});

// ── snapshot merges ───────────────────────────────────────────────────────

describe("applyChatEvent — seed / history / reset", () => {
  it("seeds an empty transcript", () => {
    const s = applyChatEvent(EMPTY_CHAT_STATE, {
      kind: "seed",
      entries: [user(1), assistant(2)],
    });
    expect(s.order).toEqual([1, 2]);
  });

  it("lets already-received events win over the snapshot", () => {
    // The ordering fix: listeners attach BEFORE chatOpen resolves, so deltas
    // can land first. The snapshot fills gaps but must not overwrite them.
    const live = fold([
      { kind: "entry", entry: assistant(2) },
      { kind: "block", entrySeq: 2, block: text("b1", "streamed") },
    ]);
    const s = applyChatEvent(live, {
      kind: "seed",
      // Stale snapshot: seq 2 with no blocks yet, plus an entry we missed.
      entries: [user(1), assistant(2)],
    });
    expect(s.order).toEqual([1, 2]);
    expect(blocksOf(s, 2)).toEqual([text("b1", "streamed")]);
  });

  it("keeps streaming correctly after the seed merges in", () => {
    const s = fold([
      { kind: "entry", entry: assistant(2) },
      { kind: "block", entrySeq: 2, block: text("b1", "str") },
      { kind: "seed", entries: [user(1), assistant(2)] },
      { kind: "block", entrySeq: 2, block: text("b1", "streamed") },
      turnEvent(2, "completed", 2000),
    ]);
    expect(blocksOf(s, 2)).toEqual([text("b1", "streamed")]);
    expect(chatBusy(chatEntries(s))).toBe(false);
  });

  it("history pages win over local state and never duplicate a seq", () => {
    const live = fold([{ kind: "entry", entry: user(3, "current") }]);
    const s = applyChatEvent(live, {
      kind: "history",
      entries: [user(1), user(2), user(3, "authoritative")],
    });
    expect(s.order).toEqual([1, 2, 3]);
    expect(chatEntries(s)).toHaveLength(3);
    expect((s.byId[3] as { display: string }).display).toBe("authoritative");
  });

  it("reset drops everything", () => {
    const s = fold([
      { kind: "entry", entry: assistant(1) },
      { kind: "block", entrySeq: 1, block: text("b1", "gone") },
      { kind: "reset" },
    ]);
    expect(s).toEqual(EMPTY_CHAT_STATE);
    expect(chatEntries(s)).toEqual([]);

    // …and a stale entry from the old conversation cannot resurrect itself
    // into a partially-cleared state: the reseed starts from nothing.
    const reseeded = applyChatEvent(s, {
      kind: "seed",
      entries: [user(1, "new conversation")],
    });
    expect(chatEntries(reseeded).map((e) => e.seq)).toEqual([1]);
  });
});

// ── projections ───────────────────────────────────────────────────────────

describe("chatEntries / chatBusy", () => {
  it("skips order entries with no matching record", () => {
    const s: ChatState = { byId: { 2: user(2) }, order: [1, 2] };
    expect(chatEntries(s).map((e) => e.seq)).toEqual([2]);
  });

  it("is busy for every active turn status", () => {
    for (const status of ["queued", "streaming", "awaitingPermission"] as const)
      expect(chatBusy([assistant(1, { status })])).toBe(true);
  });

  it("is idle for terminal statuses and non-assistant entries", () => {
    for (const status of ["completed", "cancelled", "failed"] as const)
      expect(chatBusy([assistant(1, { status })])).toBe(false);
    expect(chatBusy([user(1)])).toBe(false);
    expect(chatBusy([])).toBe(false);
  });
});
