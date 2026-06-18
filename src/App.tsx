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
import {
  workspaceLabel,
  type ContextInfo,
  type EnvReport,
  type ProjectView,
  type Workspace,
} from "./lib/types";
import { useShortcuts } from "./hooks/useShortcuts";
import { useDesktopBehaviors } from "./hooks/useDesktopBehaviors";
import { Onboarding } from "./components/Onboarding";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceView, type CenterTab } from "./components/WorkspaceView";
import { FleetDashboard } from "./components/FleetDashboard";
import { NewWorkspaceModal } from "./components/NewWorkspaceModal";
import { ProjectSettingsDialog } from "./components/ProjectSettingsDialog";
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

const LAYOUT_KEY = "branchlab.layout.v1";
const DEFAULT_LAYOUT: Layout = { left: 18, center: 82, right: 0 };

function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [rechecking, setRechecking] = useState(false);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [branchModalProject, setBranchModalProject] = useState<ProjectView | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsProject, setSettingsProject] = useState<ProjectView | null>(null);
  const [centerTab, setCenterTab] = useState<CenterTab>("activity");
  const [focusedFile, setFocusedFile] = useState<string | null>(null);
  const [viewerFile, setViewerFile] = useState<string | null>(null);
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());
  const [context, setContext] = useState<ContextInfo | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const toggleViewed = useCallback((path: string) => {
    setViewedFiles((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }, []);
  const markAllViewed = useCallback((paths: string[]) => setViewedFiles(new Set(paths)), []);

  const leftRef = usePanelRef();
  const rightRef = usePanelRef();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(true);

  const stored = useMemo<Layout | undefined>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
      if (!saved) return undefined;
      // selectedId is never persisted, so we always start in Fleet view — keep right collapsed.
      return { ...saved, right: 0 };
    } catch {
      return undefined;
    }
  }, []);
  // Live layout (percentages per panel id) so the status bar segments can align.
  const [layout, setLayout] = useState<Layout>(stored ?? DEFAULT_LAYOUT);

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

  // Reset per-workspace UI state when switching workspaces.
  useEffect(() => {
    setCenterTab("activity");
    setFocusedFile(null);
    setViewerFile(null);
    setViewedFiles(new Set());
    setContext(null);
  }, [selectedId]);

  const openFileViewer = useCallback((path: string) => {
    setViewerFile(path);
    setCenterTab("file");
  }, []);
  const closeFileViewer = useCallback(() => {
    setViewerFile(null);
    setCenterTab((t) => (t === "file" ? "activity" : t));
  }, []);

  // Hide the right (Changes) panel in the Fleet view; restore it in a workspace.
  useEffect(() => {
    const p = rightRef.current;
    if (!p) return;
    if (selectedId) p.expand();
    else p.collapse();
  }, [selectedId]);

  const onRenamed = useCallback(
    async (workspaceId: string, name: string) => {
      await renameWorkspace(workspaceId, name);
      await refreshProjects();
    },
    [refreshProjects],
  );

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
        rightAvailable={!!selected}
        onToggleLeft={toggleLeft}
        onToggleRight={toggleRight}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={stored}
        onLayoutChanged={(l) => {
          localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
          setLayout(l);
        }}
        className="min-h-0 flex-1"
      >
        <ResizablePanel
          id="left"
          panelRef={leftRef}
          collapsible
          collapsedSize="0"
          minSize="14%"
          defaultSize="18%"
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
            onOpenSettings={setSettingsProject}
          />
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel id="center" minSize="30%">
          <main className="h-full min-w-0 overflow-hidden">
            {selected && selectedProject ? (
              <WorkspaceView
                key={selected.id}
                workspace={selected}
                project={selectedProject}
                onRenamed={onRenamed}
                tab={centerTab}
                onTabChange={setCenterTab}
                focusedFile={focusedFile}
                viewerFile={viewerFile}
                onCloseFile={closeFileViewer}
                viewed={viewedFiles}
                onToggleViewed={toggleViewed}
                onMarkAllViewed={markAllViewed}
                onContext={setContext}
                reloadNonce={reloadNonce}
              />
            ) : (
              <FleetDashboard
                projects={projects}
                onOpenWorkspace={(w) => setSelectedId(w.id)}
                onAddProject={() => void pickProject()}
              />
            )}
          </main>
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel
          id="right"
          panelRef={rightRef}
          collapsible
          collapsedSize="0"
          minSize="16%"
          defaultSize="24%"
          onResize={(s) => setRightCollapsed(s.asPercentage === 0)}
        >
          <ChangesPanel
            workspace={selected}
            viewed={viewedFiles}
            onToggleViewed={toggleViewed}
            onOpenFile={(path) => {
              setCenterTab("changes");
              setFocusedFile(path);
            }}
            onViewFile={openFileViewer}
          />
        </ResizablePanel>
      </ResizablePanelGroup>

      <StatusBar
        layout={layout}
        projectCount={projects.length}
        workspaceCount={allWorkspaces.length}
        workspace={selected}
        context={context}
        opencodeVersion={phase.env.opencode.version}
      />

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      {branchModalProject && (
        <NewWorkspaceModal
          project={branchModalProject}
          onClose={() => setBranchModalProject(null)}
          onCreated={(ws) => void onWorkspaceCreated(ws)}
        />
      )}
      {settingsProject && (
        <ProjectSettingsDialog
          project={settingsProject}
          open
          onOpenChange={(open) => !open && setSettingsProject(null)}
          onUpdated={(updated) => {
            setProjects((prev) => prev.map((p) => (p.id === updated.id ? { ...updated, workspaces: p.workspaces } : p)));
            setSettingsProject((current) => (current?.id === updated.id ? { ...updated, workspaces: current.workspaces } : current));
          }}
          workspaceId={selected?.id ?? settingsProject.workspaces[0]?.id ?? ""}
          onConfigRestarted={() => setReloadNonce((n) => n + 1)}
        />
      )}
    </div>
  );
}

export default App;
