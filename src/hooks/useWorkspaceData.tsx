// Shared polling layer for workspace-scoped git data.
//
// Multiple panels (sidebar, fleet, changes view, changes panel) used to each
// run their own setInterval against the same Tauri commands — sometimes twice
// per workspace per cycle. This provider polls once and exposes the latest
// snapshot via context.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { workspaceChanges, workspaceDiffStat } from "../lib/api";
import type { DiffStat, FileChange } from "../lib/types";

const DIFF_STAT_INTERVAL_MS = 4000;
const CHANGES_INTERVAL_MS = 4000;

interface WorkspaceDataValue {
  /** Latest diff stats keyed by workspace id (updated periodically). */
  diffStats: Record<string, DiffStat>;
  /** Latest changed files for the active workspace, or undefined if none. */
  changes: FileChange[] | undefined;
  /** Force-refresh changes for the active workspace (e.g. after `discardFile`). */
  refreshChanges: () => void;
}

const Ctx = createContext<WorkspaceDataValue>({
  diffStats: {},
  changes: undefined,
  refreshChanges: () => {},
});

interface ProviderProps {
  /** Every workspace id we want diff stats for (sidebar + fleet). */
  workspaceIds: string[];
  /** The workspace currently shown in the center/right panels, if any. */
  activeWorkspaceId: string | null;
  children: React.ReactNode;
}

export function WorkspaceDataProvider({ workspaceIds, activeWorkspaceId, children }: ProviderProps) {
  const [diffStats, setDiffStats] = useState<Record<string, DiffStat>>({});
  const [changes, setChanges] = useState<FileChange[] | undefined>(undefined);

  // Stash the latest id list in a ref so the poll function doesn't re-create
  // (and re-time) on every projects update.
  const idsRef = useRef(workspaceIds);
  idsRef.current = workspaceIds;

  // ── Diff stats: one poll for every known workspace, single timer. ──
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const ids = idsRef.current;
      const entries = await Promise.all(
        ids.map(async (id) => [id, await workspaceDiffStat(id)] as const),
      );
      if (!cancelled) setDiffStats(Object.fromEntries(entries));
    };
    void poll();
    const t = setInterval(() => void poll(), DIFF_STAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // ── Changes: only for the active workspace. ──
  useEffect(() => {
    if (!activeWorkspaceId) {
      setChanges(undefined);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const data = await workspaceChanges(activeWorkspaceId).catch(() => [] as FileChange[]);
      if (!cancelled) setChanges(data);
    };
    void poll();
    const t = setInterval(() => void poll(), CHANGES_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [activeWorkspaceId]);

  const refreshChanges = useCallback(() => {
    if (!activeWorkspaceId) return;
    void workspaceChanges(activeWorkspaceId)
      .then(setChanges)
      .catch(() => {});
  }, [activeWorkspaceId]);

  return <Ctx.Provider value={{ diffStats, changes, refreshChanges }}>{children}</Ctx.Provider>;
}

export function useWorkspaceData(): WorkspaceDataValue {
  return useContext(Ctx);
}
