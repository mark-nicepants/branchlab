// The chat transcript's state machine, as a pure reducer.
//
// `useChat` is a thin view over the Rust chat layer: it seeds once from a
// `chatOpen` snapshot and then folds `chat:*` deltas into a normalized
// per-seq map. That fold is the only real logic in the hook and the place two
// shipped bugs lived (streaming corruption, duplicate delivery), so it lives
// here as a pure function instead of inside a `setState` callback.
//
// Delivery contract (mirrors src-tauri/src/chat/events.rs):
//   - Every `chat:block` carries the FULL authoritative block, keyed by
//     `blockId` — never a delta to append. Duplicated, reordered or dropped
//     deliveries therefore cannot corrupt the rendered text: an upsert is
//     idempotent and the next event heals any gap.
//   - Entries upsert by `seq`; a re-delivered entry replaces the older copy.
//   - Events may land for a seq we have not seen yet (or for a non-assistant
//     entry). Those are dropped, not synthesized: the backend re-emits the
//     entry, and the following block/turn event restores the state.

import type { Block, ChatTurnEvent, Entry } from "./types";

/** Everything the transcript projection needs: entries keyed by seq, plus the
 *  render order (kept sorted so a late-arriving low seq slots into place). */
export interface ChatState {
  byId: Record<number, Entry>;
  order: number[];
}

export const EMPTY_CHAT_STATE: ChatState = { byId: {}, order: [] };

/** A `chat:*` delta, or one of the two snapshot merges (initial seed / older
 *  history page), narrowed to the fields that affect transcript state. */
export type ChatStateEvent =
  | { kind: "entry"; entry: Entry }
  | { kind: "block"; entrySeq: number; block: Block }
  | ({ kind: "turn" } & Omit<ChatTurnEvent, "workspaceId">)
  /** The `chatOpen` snapshot, merged UNDER whatever deltas raced in while it
   *  loaded: the snapshot fills gaps, an already-received event wins. */
  | { kind: "seed"; entries: Entry[] }
  /** An older `chatHistory` page. The opposite precedence: the page is
   *  authoritative for entries that already scrolled out of the live window. */
  | { kind: "history"; entries: Entry[] }
  /** Conversation replaced (compacted/cleared) — drop everything so the
   *  reseed cannot merge stale entries back in. */
  | { kind: "reset" };

/** Merge a streamed block into a turn's block list: upsert by blockId. */
function applyBlock(blocks: Block[], block: Block): Block[] {
  const idx = blocks.findIndex((b) => b.blockId === block.blockId);
  if (idx === -1) return [...blocks, block];
  const next = blocks.slice();
  next[idx] = block;
  return next;
}

const sorted = (seqs: Iterable<number>) => [...seqs].sort((a, b) => a - b);

export function applyChatEvent(
  state: ChatState,
  event: ChatStateEvent,
): ChatState {
  switch (event.kind) {
    case "entry": {
      const { seq } = event.entry;
      return {
        byId: { ...state.byId, [seq]: event.entry },
        order: state.order.includes(seq)
          ? state.order
          : sorted([...state.order, seq]),
      };
    }
    case "block": {
      const e = state.byId[event.entrySeq];
      // Unknown seq or a non-assistant entry: nothing to attach the block to.
      if (!e || e.type !== "assistant") return state;
      return {
        ...state,
        byId: {
          ...state.byId,
          [event.entrySeq]: { ...e, blocks: applyBlock(e.blocks, event.block) },
        },
      };
    }
    case "turn": {
      const e = state.byId[event.entrySeq];
      if (!e || e.type !== "assistant") return state;
      return {
        ...state,
        byId: {
          ...state.byId,
          [event.entrySeq]: {
            ...e,
            status: event.status,
            summary: event.summary,
            usage: event.usage,
            // A non-terminal transition carries no endedAt; keep the old one.
            endedAt: event.endedAt ?? e.endedAt,
          },
        },
      };
    }
    case "seed":
    case "history": {
      const map: Record<number, Entry> = {};
      for (const e of event.entries) map[e.seq] = e;
      return {
        byId:
          event.kind === "seed"
            ? { ...map, ...state.byId }
            : { ...state.byId, ...map },
        order: sorted(
          new Set([...state.order, ...event.entries.map((e) => e.seq)]),
        ),
      };
    }
    case "reset":
      return EMPTY_CHAT_STATE;
  }
}

/** The rendered transcript: entries in seq order. */
export function chatEntries(state: ChatState): Entry[] {
  return state.order.map((seq) => state.byId[seq]).filter(Boolean);
}

const ACTIVE = new Set(["queued", "streaming", "awaitingPermission"]);

/** True while any assistant turn is still running (drives the stop button). */
export function chatBusy(entries: Entry[]): boolean {
  return entries.some((e) => e.type === "assistant" && ACTIVE.has(e.status));
}
