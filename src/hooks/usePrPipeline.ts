// Thin view over the backend-owned PR pipeline state.
//
// The polling + autofix/superfix state machine lives in the Rust supervisor,
// which pushes `workspace:pr` events. Those are accumulated per-workspace in
// WorkspaceDataProvider (app-level, so state survives workspace switches); this
// hook just selects the entry for one workspace. Mode changes go through the
// `set_autofix_mode` command (see SessionView / api.ts). See AGENTS.md.

import type { PipelinePhase, PrStatus } from "../lib/types";
import { useWorkspaceData } from "./useWorkspaceData";

interface PipelineState {
  status: PrStatus | null;
  phase: PipelinePhase;
  attempts: number;
}

export function usePrPipeline(
  workspaceId: string,
  enabled: boolean,
): PipelineState {
  const { prByWorkspace } = useWorkspaceData();
  const p = enabled ? prByWorkspace[workspaceId] : undefined;
  return {
    status: p?.status ?? null,
    phase: p?.phase ?? "idle",
    attempts: p?.attempts ?? 0,
  };
}
