// The chat store hook — a thin view over the Rust chat layer.
//
// Seeds from `chatOpen` (a one-time snapshot, since Tauri events aren't
// buffered — same discipline as useWorkspaceData's snapshot seed) and applies
// `chat:*` deltas into a normalized per-seq map. All transcript state lives in
// the Rust backend + SQLite; this is just the rendered projection, so switching
// workspaces reloads instantly from cache and survives restarts.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  chatAbort,
  chatAnswerPermission,
  chatHistory,
  chatNewSession,
  chatOpen,
  chatSend,
  chatSetConfig,
} from "../lib/api";
import {
  onChatBlock,
  onChatCommands,
  onChatConfig,
  onChatContext,
  onChatEntry,
  onChatPermission,
  onChatReset,
  onChatTurn,
} from "../lib/events";
import type {
  Block,
  ChatAttachment,
  ChatCommand,
  ChatPermissionEvent,
  ConfigOption,
  ContextInfo,
  Entry,
} from "../lib/types";

/** Merge a streamed block into a turn's block list (upsert by blockId). For a
 *  text/reasoning delta the backend sends only `textAppend` (the block's text is
 *  blank) so we append rather than replace; other updates replace the block. */
function applyBlock(
  blocks: Block[],
  block: Block,
  textAppend: string | null,
): Block[] {
  const idx = blocks.findIndex((b) => b.blockId === block.blockId);
  if (idx === -1) return [...blocks, block];
  const cur = blocks[idx];
  const next = blocks.slice();
  if (textAppend != null && (cur.type === "text" || cur.type === "reasoning")) {
    next[idx] = { ...cur, text: cur.text + textAppend };
  } else {
    next[idx] = block;
  }
  return next;
}

const ACTIVE = new Set(["queued", "streaming", "awaitingPermission"]);

export interface ChatStore {
  entries: Entry[];
  config: ConfigOption[];
  context: ContextInfo | null;
  commands: ChatCommand[];
  permissions: ChatPermissionEvent[];
  hasMore: boolean;
  loading: boolean;
  /** True while the newest assistant turn is still running. */
  busy: boolean;
  send: (args: {
    display: string;
    sent: string;
    attachments?: ChatAttachment[];
    origin?: string;
    model?: string;
    variant?: string;
    agent?: string;
  }) => Promise<void>;
  abort: () => void;
  setConfig: (id: string, value: string) => void;
  answerPermission: (requestId: string, optionId: string | null) => void;
  newSession: (reason: "compacted" | "cleared") => void;
  loadMore: () => void;
}

export function useChat(workspaceId: string): ChatStore {
  const [byId, setById] = useState<Record<number, Entry>>({});
  const [order, setOrder] = useState<number[]>([]);
  const [config, setConfig] = useState<ConfigOption[]>([]);
  const [context, setContext] = useState<ContextInfo | null>(null);
  const [commands, setCommands] = useState<ChatCommand[]>([]);
  const [permissions, setPermissions] = useState<ChatPermissionEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [oldestSeq, setOldestSeq] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await chatOpen(workspaceId);
      const map: Record<number, Entry> = {};
      for (const e of snap.entries) map[e.seq] = e;
      setById(map);
      setOrder(snap.entries.map((e) => e.seq));
      setConfig(snap.config);
      setCommands(snap.commands ?? []);
      setHasMore(snap.hasMore);
      setOldestSeq(snap.entries[0]?.seq ?? null);
      setPermissions([]);
    } catch {
      /* backend not ready / no conversation yet */
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  // Seed on workspace switch.
  useEffect(() => {
    setById({});
    setOrder([]);
    setContext(null);
    setPermissions([]);
    void reload();
  }, [reload]);

  // Subscribe to deltas for this workspace.
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let cancelled = false;
    const track = (p: Promise<() => void>) =>
      void p.then((fn) => (cancelled ? fn() : unsubs.push(fn)));
    const mine =
      <T extends { workspaceId: string }>(cb: (p: T) => void) =>
      (p: T) => {
        if (p.workspaceId === workspaceId) cb(p);
      };

    const upsert = (e: Entry) => {
      setById((prev) => ({ ...prev, [e.seq]: e }));
      setOrder((prev) =>
        prev.includes(e.seq) ? prev : [...prev, e.seq].sort((a, b) => a - b),
      );
    };

    track(onChatEntry(mine((p) => upsert(p.entry))));
    track(
      onChatBlock(
        mine((p) =>
          setById((prev) => {
            const e = prev[p.entrySeq];
            if (!e || e.type !== "assistant") return prev;
            return {
              ...prev,
              [p.entrySeq]: {
                ...e,
                blocks: applyBlock(e.blocks, p.block, p.textAppend),
              },
            };
          }),
        ),
      ),
    );
    track(
      onChatTurn(
        mine((p) =>
          setById((prev) => {
            const e = prev[p.entrySeq];
            if (!e || e.type !== "assistant") return prev;
            return {
              ...prev,
              [p.entrySeq]: {
                ...e,
                status: p.status,
                summary: p.summary,
                usage: p.usage,
              },
            };
          }),
        ),
      ),
    );
    track(onChatConfig(mine((p) => setConfig(p.options))));
    track(onChatContext(mine((p) => setContext({ used: p.used, max: p.max }))));
    track(onChatCommands(mine((p) => setCommands(p.commands))));
    track(
      onChatPermission(
        mine((p) =>
          setPermissions((prev) =>
            prev.some((x) => x.requestId === p.requestId) ? prev : [...prev, p],
          ),
        ),
      ),
    );
    track(onChatReset(mine(() => void reload())));

    return () => {
      cancelled = true;
      unsubs.forEach((f) => f());
    };
  }, [workspaceId, reload]);

  const entries = useMemo(
    () => order.map((seq) => byId[seq]).filter(Boolean),
    [order, byId],
  );

  const busy = useMemo(
    () => entries.some((e) => e.type === "assistant" && ACTIVE.has(e.status)),
    [entries],
  );

  const send: ChatStore["send"] = useCallback(
    (args) => chatSend({ workspaceId, ...args }),
    [workspaceId],
  );
  const abort = useCallback(() => void chatAbort(workspaceId), [workspaceId]);
  const setConfigValue = useCallback(
    (id: string, value: string) => void chatSetConfig(workspaceId, id, value),
    [workspaceId],
  );
  const answerPermission = useCallback(
    (requestId: string, optionId: string | null) => {
      setPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
      void chatAnswerPermission(workspaceId, requestId, optionId);
    },
    [workspaceId],
  );
  const newSession = useCallback(
    (reason: "compacted" | "cleared") =>
      void chatNewSession(workspaceId, reason),
    [workspaceId],
  );
  const loadMore = useCallback(() => {
    if (oldestSeq == null) return;
    void chatHistory(workspaceId, oldestSeq).then((snap) => {
      if (snap.entries.length === 0) {
        setHasMore(false);
        return;
      }
      setById((prev) => {
        const map = { ...prev };
        for (const e of snap.entries) map[e.seq] = e;
        return map;
      });
      setOrder((prev) =>
        [...snap.entries.map((e) => e.seq), ...prev].sort((a, b) => a - b),
      );
      setOldestSeq(snap.entries[0]?.seq ?? oldestSeq);
      setHasMore(snap.hasMore);
    });
  }, [workspaceId, oldestSeq]);

  return {
    entries,
    config,
    context,
    commands,
    permissions,
    hasMore,
    loading,
    busy,
    send,
    abort,
    setConfig: setConfigValue,
    answerPermission,
    newSession,
    loadMore,
  };
}
