// Shared workspace-scoped git data, pushed from the backend.
//
// The Rust filesystem watcher (watcher.rs) recomputes git state on change and
// emits `workspace:git`; this provider just listens and exposes the latest
// snapshot via context. No polling — see AGENTS.md. `changes` is populated by
// the backend only for the active workspace (the heavier query); other
// workspaces carry just the badge-level `diffStat`.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getSidebarSnapshot,
  refreshPrStatus,
  requestGitRefresh,
  setActiveWorkspace,
} from "../lib/api";
import {
  onWorkspaceGit,
  onWorkspacePr,
  onWorkspaceSession,
} from "../lib/events";
import type {
  DiffStat,
  FileChange,
  GitPayload,
  PrPayload,
  SessionPayload,
} from "../lib/types";

interface WorkspaceDataValue {
  /** Latest diff stats keyed by workspace id. */
  diffStats: Record<string, DiffStat>;
  /** Latest changed files for the active workspace, or undefined if none. */
  changes: FileChange[] | undefined;
  /** Force-refresh changes for the active workspace (e.g. after `discardFile`). */
  refreshChanges: () => void;
  /** Latest PR pipeline payload keyed by workspace id. Held here (app-level,
   *  never unmounts) so switching workspaces keeps the last-known status
   *  instead of blanking until the next backend push. */
  prByWorkspace: Record<string, PrPayload>;
  /** Latest coarse session state keyed by workspace id (activity + the
   *  backend-computed `needsAttention`). Covers any workspace with a running
   *  server, including background turns you've navigated away from. Drives the
   *  sidebar busy/attention indicators. */
  sessionByWorkspace: Record<string, SessionPayload>;
  /** Live checked-out branch keyed by workspace id — pushed by the watcher
   *  when the agent renames/switches branches. Overlays the (possibly stale)
   *  registry `Workspace.branch` in the UI. */
  branchByWorkspace: Record<string, string>;
}

const Ctx = createContext<WorkspaceDataValue>({
  diffStats: {},
  changes: undefined,
  refreshChanges: () => {},
  prByWorkspace: {},
  sessionByWorkspace: {},
  branchByWorkspace: {},
});

interface ProviderProps {
  /** The workspace currently shown in the center/right panels, if any. */
  activeWorkspaceId: string | null;
  children: React.ReactNode;
}

export function WorkspaceDataProvider({
  activeWorkspaceId,
  children,
}: ProviderProps) {
  // Latest git payload per workspace id, keyed by workspaceId.
  const [byId, setById] = useState<Record<string, GitPayload>>({});
  // Latest PR + session payloads per workspace id (persist across switches).
  const [prByWorkspace, setPrByWorkspace] = useState<Record<string, PrPayload>>(
    {},
  );
  const [sessionByWorkspace, setSessionByWorkspace] = useState<
    Record<string, SessionPayload>
  >({});

  // Subscribe to backend git + PR + session pushes once, then seed the store
  // from one complete snapshot read ("pull once, push forever"). The snapshot
  // is a synchronous read of backend caches, so no startup ordering race can
  // leave a workspace blank; events only apply deltas afterwards. The backend
  // computes session state (including `needsAttention`) — no client derivation.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    const track = (p: Promise<() => void>) =>
      void p.then((fn) => (cancelled ? fn() : unlisteners.push(fn)));

    track(
      onWorkspaceGit((p) =>
        setById((prev) => ({ ...prev, [p.workspaceId]: p })),
      ),
    );
    track(
      onWorkspacePr((p) =>
        setPrByWorkspace((prev) => ({ ...prev, [p.workspaceId]: p })),
      ),
    );
    track(
      onWorkspaceSession((p) =>
        setSessionByWorkspace((prev) => ({ ...prev, [p.workspaceId]: p })),
      ),
    );
    // Seed AFTER subscribing, so a delta arriving in between isn't lost (a
    // stale snapshot entry would just be overwritten by the newer event).
    void getSidebarSnapshot().then((snapshot) => {
      if (cancelled) return;
      setById((prev) => {
        const next = { ...prev };
        for (const w of snapshot) {
          if (!next[w.workspaceId])
            next[w.workspaceId] = {
              workspaceId: w.workspaceId,
              diffStat: w.diffStat,
              changes: null,
            };
        }
        return next;
      });
      setPrByWorkspace((prev) => {
        const next = { ...prev };
        for (const w of snapshot)
          if (!next[w.workspaceId]) next[w.workspaceId] = w.pr;
        return next;
      });
      setSessionByWorkspace((prev) => {
        const next = { ...prev };
        for (const w of snapshot)
          if (!next[w.workspaceId]) next[w.workspaceId] = w.session;
        return next;
      });
    });
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Window focus → immediate PR re-poll (throttled): the user is looking, so
  // the slow safety-net cadence isn't fresh enough.
  const lastFocusPoke = useRef(0);
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusPoke.current < 15_000) return;
      lastFocusPoke.current = now;
      void refreshPrStatus();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Tell the backend which workspace is active (it then also emits `changes`
  // and clears that workspace's `needsAttention`).
  useEffect(() => {
    void setActiveWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId]);

  const diffStats = useMemo(() => {
    const out: Record<string, DiffStat> = {};
    for (const [id, p] of Object.entries(byId)) out[id] = p.diffStat;
    return out;
  }, [byId]);

  const branchByWorkspace = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [id, p] of Object.entries(byId))
      if (p.branch) out[id] = p.branch;
    return out;
  }, [byId]);

  const changes = activeWorkspaceId
    ? (byId[activeWorkspaceId]?.changes ?? undefined)
    : undefined;

  const refreshChanges = useCallback(() => {
    if (activeWorkspaceId) void requestGitRefresh(activeWorkspaceId);
  }, [activeWorkspaceId]);

  return (
    <Ctx.Provider
      value={{
        diffStats,
        changes,
        refreshChanges,
        prByWorkspace,
        sessionByWorkspace,
        branchByWorkspace,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useWorkspaceData(): WorkspaceDataValue {
  return useContext(Ctx);
}
