// The chat store hook — a thin view over the Rust chat layer.
//
// Seeds from `chatOpen` (a one-time snapshot, since Tauri events aren't
// buffered — same discipline as useWorkspaceData's snapshot seed) and applies
// `chat:*` deltas into a normalized per-seq map. All transcript state lives in
// the Rust backend + SQLite; this is just the rendered projection, so switching
// workspaces reloads instantly from cache and survives restarts.

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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
  listenAll,
  onChatBlock,
  onChatCommands,
  onChatConfig,
  onChatContext,
  onChatEntry,
  onChatPermission,
  onChatReset,
  onChatTurn,
} from "../lib/events";
import {
  applyChatEvent,
  chatBusy,
  chatEntries,
  EMPTY_CHAT_STATE,
  type ChatStateEvent,
} from "../lib/chatState";
import type {
  ChatAttachment,
  ChatCommand,
  ChatPermissionEvent,
  ConfigOption,
  ContextInfo,
  Entry,
  TurnOrigin,
} from "../lib/types";

export interface ChatStore {
  entries: Entry[];
  config: ConfigOption[];
  context: ContextInfo | null;
  commands: ChatCommand[];
  permissions: ChatPermissionEvent[];
  hasMore: boolean;
  loading: boolean;
  /** True once the delta event listeners are attached. A programmatic send
   *  before this can lose its entry events (listen() is async), leaving the
   *  transcript blank until the next reload — gate auto-sends on it. */
  ready: boolean;
  /** True while the newest assistant turn is still running. */
  busy: boolean;
  send: (args: {
    display: string;
    sent: string;
    attachments?: ChatAttachment[];
    origin?: TurnOrigin;
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
  const [state, setState] = useState(EMPTY_CHAT_STATE);
  const [config, setConfig] = useState<ConfigOption[]>([]);
  const [context, setContext] = useState<ContextInfo | null>(null);
  const [commands, setCommands] = useState<ChatCommand[]>([]);
  const [permissions, setPermissions] = useState<ChatPermissionEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [oldestSeq, setOldestSeq] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscribed, setSubscribed] = useState(false);

  // Subscribe to deltas first, then seed from the snapshot once the listeners
  // are live — the reverse order drops any delta landing in the gap (a lost
  // terminal `chat:turn` would leave `busy` stuck). Same "pull once, push
  // forever" discipline as useWorkspaceData.
  useEffect(() => {
    setState(EMPTY_CHAT_STATE);
    setContext(null);
    setPermissions([]);
    setSubscribed(false);
    setLoading(true);

    const mine =
      <T extends { workspaceId: string }>(cb: (p: T) => void) =>
      (p: T) => {
        if (p.workspaceId === workspaceId) cb(p);
      };

    const apply = (e: ChatStateEvent) => setState((s) => applyChatEvent(s, e));

    // Merge the snapshot under whatever deltas raced in while it loaded: the
    // snapshot fills the gaps, but an already-received event is newer and wins
    // (later events heal any remaining staleness — see applyChatEvent).
    const seed = async () => {
      setLoading(true);
      try {
        const snap = await chatOpen(workspaceId);
        if (subs.disposed) return;
        apply({ kind: "seed", entries: snap.entries });
        setConfig(snap.config);
        setCommands(snap.commands ?? []);
        setHasMore(snap.hasMore);
        setOldestSeq(snap.entries[0]?.seq ?? null);
      } catch {
        /* backend not ready / no conversation yet */
      } finally {
        if (!subs.disposed) setLoading(false);
      }
    };

    const subs = listenAll(
      onChatEntry(mine((p) => apply({ kind: "entry", entry: p.entry }))),
      onChatBlock(
        mine((p) =>
          apply({ kind: "block", entrySeq: p.entrySeq, block: p.block }),
        ),
      ),
      onChatTurn(
        mine(({ workspaceId: _w, ...turn }) =>
          apply({ kind: "turn", ...turn }),
        ),
      ),
      onChatConfig(mine((p) => setConfig(p.options))),
      onChatContext(mine((p) => setContext({ used: p.used, max: p.max }))),
      onChatCommands(mine((p) => setCommands(p.commands))),
      onChatPermission(
        mine((p) =>
          setPermissions((prev) =>
            prev.some((x) => x.requestId === p.requestId) ? prev : [...prev, p],
          ),
        ),
      ),
      onChatReset(
        mine(() => {
          // Conversation replaced (compacted/cleared): drop local state so the
          // reseed doesn't merge stale entries back in.
          apply({ kind: "reset" });
          setPermissions([]);
          void seed();
        }),
      ),
    );

    // listen() registration is async; seed only once every subscription is
    // live (`ready` also lets callers safely fire programmatic sends).
    void subs.ready.then((live) => {
      if (!live) return;
      setSubscribed(true);
      void seed();
    });

    return subs.dispose;
  }, [workspaceId]);

  const entries = useMemo(() => chatEntries(state), [state]);
  const busy = useMemo(() => chatBusy(entries), [entries]);

  const send: ChatStore["send"] = useCallback(
    (args) => chatSend({ workspaceId, ...args }),
    [workspaceId],
  );
  // These commands now report failures instead of swallowing them — surface
  // each as a toast (an unanswered click otherwise just looks broken).
  const abort = useCallback(
    () =>
      void chatAbort(workspaceId).catch((e) =>
        toast.error("Could not stop the turn", { description: String(e) }),
      ),
    [workspaceId],
  );
  const setConfigValue = useCallback(
    (id: string, value: string) =>
      void chatSetConfig(workspaceId, id, value).catch((e) =>
        toast.error("Could not change the setting", {
          description: String(e),
        }),
      ),
    [workspaceId],
  );
  const answerPermission = useCallback(
    (requestId: string, optionId: string | null) => {
      setPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
      void chatAnswerPermission(workspaceId, requestId, optionId).catch((e) =>
        toast.error("Could not answer the permission request", {
          description: String(e),
        }),
      );
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
      setState((s) =>
        applyChatEvent(s, { kind: "history", entries: snap.entries }),
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
    ready: subscribed,
    busy,
    send,
    abort,
    setConfig: setConfigValue,
    answerPermission,
    newSession,
    loadMore,
  };
}
