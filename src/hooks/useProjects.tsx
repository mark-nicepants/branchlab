// The registry snapshot — projects (each with its workspaces) plus the
// project-less quick chats — shared app-wide.
//
// This is a pull-based counterpart to `useWorkspaceData`: the registry only
// changes as a result of a user action (or a finished provisioning run), so
// there is no event stream to fold in — consumers call `refresh()` after a
// mutation and the backend is re-read once. Lookup maps live here too, so the
// sidebar, the board, and the session view share one derivation instead of
// each rebuilding it.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { listProjects, listWorkspaces } from "../lib/api";
import { onWorkspaceSetup } from "../lib/events";
import type { ProjectView, Workspace } from "../lib/types";

interface ProjectsValue {
  projects: ProjectView[];
  /** Quick chats live in the same registry but under no project. */
  quickChats: Workspace[];
  /** Every workspace (project workspaces + quick chats) keyed by id. */
  workspaceById: Map<string, Workspace>;
  projectById: Map<string, ProjectView>;
  /** Re-read the registry snapshot from the backend. */
  refresh: () => Promise<void>;
  /** Insert a just-created workspace optimistically: creation returns before
   *  provisioning finishes, so the UI can navigate to it while the registry
   *  refresh catches up in the background. */
  addWorkspace: (ws: Workspace) => void;
  /** Fold an edited project back into the snapshot, keeping its workspaces
   *  (the project settings dialog returns the project without them). */
  applyProject: (project: ProjectView) => void;
}

const Ctx = createContext<ProjectsValue>({
  projects: [],
  quickChats: [],
  workspaceById: new Map(),
  projectById: new Map(),
  refresh: async () => {},
  addWorkspace: () => {},
  applyProject: () => {},
});

export function ProjectsProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [quickChats, setQuickChats] = useState<Workspace[]>([]);

  const refresh = useCallback(async () => {
    // Quick chats belong to no project, so they come from the flat workspace
    // list rather than the project views.
    const [projs, workspaces] = await Promise.all([
      listProjects(),
      listWorkspaces(),
    ]);
    setProjects(projs);
    setQuickChats(workspaces.filter((w) => w.kind === "QuickChat"));
  }, []);

  // When a workspace finishes provisioning, refresh the registry snapshot so
  // every consumer of `Workspace.setup` (sidebar rows, etc.) heals even if a
  // live overlay missed the event.
  useEffect(() => {
    const unlisten = onWorkspaceSetup((p) => {
      if (!p.running) void refresh();
    });
    return () => void unlisten.then((f) => f());
  }, [refresh]);

  const addWorkspace = useCallback((ws: Workspace) => {
    if (ws.kind === "QuickChat") {
      setQuickChats((prev) => [...prev, ws]);
    } else {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === ws.project_id
            ? { ...p, workspaces: [...p.workspaces, ws] }
            : p,
        ),
      );
    }
  }, []);

  const applyProject = useCallback((updated: ProjectView) => {
    setProjects((prev) =>
      prev.map((p) =>
        p.id === updated.id ? { ...updated, workspaces: p.workspaces } : p,
      ),
    );
  }, []);

  const workspaceById = useMemo(
    () =>
      new Map(
        [...projects.flatMap((p) => p.workspaces), ...quickChats].map((w) => [
          w.id,
          w,
        ]),
      ),
    [projects, quickChats],
  );
  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  const value = useMemo(
    () => ({
      projects,
      quickChats,
      workspaceById,
      projectById,
      refresh,
      addWorkspace,
      applyProject,
    }),
    [
      projects,
      quickChats,
      workspaceById,
      projectById,
      refresh,
      addWorkspace,
      applyProject,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProjects(): ProjectsValue {
  return useContext(Ctx);
}
