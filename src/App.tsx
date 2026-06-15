import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { usePanelRef, type Layout } from "react-resizable-panels";
import {
  addProject,
  createWorkspace,
  listProjects,
  openDevtools,
  probeEnvironment,
  renameWorkspace,
  touchServer,
} from "./lib/api";
import { workspaceLabel, type EnvReport, type ProjectView, type Workspace } from "./lib/types";
import { useShortcuts } from "./hooks/useShortcuts";
import { useDesktopBehaviors } from "./hooks/useDesktopBehaviors";
import { Onboarding } from "./components/Onboarding";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceView } from "./components/WorkspaceView";
import { FleetDashboard } from "./components/FleetDashboard";
import { NewWorkspaceModal } from "./components/NewWorkspaceModal";
import { StatusBar } from "./components/StatusBar";
import { Titlebar } from "./components/layout/Titlebar";
import { ChangesPanel } from "./components/layout/ChangesPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; env: EnvReport }
  | { kind: "blocked"; env: EnvReport };

const LAYOUT_KEY = "openscope.layout.v1";

function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [rechecking, setRechecking] = useState(false);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [branchModalProject, setBranchModalProject] = useState<ProjectView | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const leftRef = usePanelRef();
  const rightRef = usePanelRef();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  // Persisted panel layout (react-resizable-panels v4: keyed by panel id).
  const defaultLayout = useMemo<Layout | undefined>(() => {
    try {
      return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null") ?? undefined;
    } catch {
      return undefined;
    }
  }, []);

  useDesktopBehaviors();

  const check = useCallback(async () => {
    setRechecking(true);
    try {
      const env = await probeEnvironment();
      setPhase({ kind: env.opencode.found ? "ready" : "blocked", env });
    } finally {
      setRechecking(false);
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    setProjects(await listProjects());
  }, []);

  const pickProject = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false, title: "Select a git repository" });
    if (typeof dir !== "string") return;
    try {
      await addProject(dir);
      await refreshProjects();
    } catch (e) {
      toast.error("Could not add project", { description: String(e) });
    }
  }, [refreshProjects]);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    if (phase.kind === "ready") void refreshProjects();
  }, [phase.kind, refreshProjects]);

  const allWorkspaces = useMemo(() => projects.flatMap((p) => p.workspaces), [projects]);
  const selected = selectedId ? allWorkspaces.find((w) => w.id === selectedId) ?? null : null;
  const selectedProject = selected
    ? projects.find((p) => p.id === selected.project_id) ?? null
    : null;

  useEffect(() => {
    if (!selectedId) return;
    void touchServer(selectedId);
    const t = setInterval(() => void touchServer(selectedId), 60_000);
    return () => clearInterval(t);
  }, [selectedId]);

  const onRenamed = useCallback(
    async (workspaceId: string, name: string) => {
      await renameWorkspace(workspaceId, name);
      await refreshProjects();
    },
    [refreshProjects],
  );

  // After a workspace is created (quick "+" or "From branch"), refresh and open it.
  const onWorkspaceCreated = useCallback(
    async (ws: Workspace) => {
      await refreshProjects();
      setSelectedId(ws.id);
    },
    [refreshProjects],
  );

  const quickCreate = useCallback(
    async (project: ProjectView) => {
      try {
        const ws = await createWorkspace(project.id);
        await onWorkspaceCreated(ws);
      } catch (e) {
        toast.error("Could not create workspace", { description: String(e) });
      }
    },
    [onWorkspaceCreated],
  );

  const toggle = (ref: ReturnType<typeof usePanelRef>) => () => {
    const p = ref.current;
    if (!p) return;
    p.isCollapsed() ? p.expand() : p.collapse();
  };
  const toggleLeft = toggle(leftRef);
  const toggleRight = toggle(rightRef);

  useShortcuts({
    toggleLeft,
    toggleRight,
    openSettings: () => setSettingsOpen(true),
    openInspector: () => void openDevtools(),
    newProject: () => void pickProject(),
  });

  if (phase.kind === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        Checking environment…
      </div>
    );
  }

  if (phase.kind === "blocked") {
    return <Onboarding env={phase.env} onRecheck={check} rechecking={rechecking} />;
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Titlebar
        project={selectedProject?.name ?? null}
        branch={selected ? workspaceLabel(selected) : null}
        leftCollapsed={leftCollapsed}
        rightCollapsed={rightCollapsed}
        onToggleLeft={toggleLeft}
        onToggleRight={toggleRight}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={(layout) => localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))}
        className="min-h-0 flex-1"
      >
        <ResizablePanel
          id="left"
          panelRef={leftRef}
          collapsible
          collapsedSize={0}
          minSize={12}
          defaultSize={18}
          onResize={(s) => setLeftCollapsed(s.asPercentage === 0)}
        >
          <Sidebar
            projects={projects}
            selectedWorkspaceId={selectedId}
            onSelectWorkspace={(w: Workspace) => setSelectedId(w.id)}
            onProjectsChanged={refreshProjects}
            onShowFleet={() => setSelectedId(null)}
            onQuickCreate={(p) => void quickCreate(p)}
            onNewFromBranch={setBranchModalProject}
            onAddProject={() => void pickProject()}
          />
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel id="center" minSize={30}>
          <main className="h-full min-w-0 overflow-hidden">
            {selected ? (
              <WorkspaceView key={selected.id} workspace={selected} onRenamed={onRenamed} />
            ) : (
              <FleetDashboard projects={projects} onOpenWorkspace={(w) => setSelectedId(w.id)} />
            )}
          </main>
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel
          id="right"
          panelRef={rightRef}
          collapsible
          collapsedSize={0}
          minSize={16}
          defaultSize={24}
          onResize={(s) => setRightCollapsed(s.asPercentage === 0)}
        >
          <ChangesPanel workspace={selected} />
        </ResizablePanel>
      </ResizablePanelGroup>

      <StatusBar workspace={selected} workspaceCount={allWorkspaces.length} />

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      {branchModalProject && (
        <NewWorkspaceModal
          project={branchModalProject}
          onClose={() => setBranchModalProject(null)}
          onCreated={(ws) => void onWorkspaceCreated(ws)}
        />
      )}
    </div>
  );
}

export default App;
