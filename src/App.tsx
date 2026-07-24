import { cn } from "@/lib/utils";
import { open } from "@tauri-apps/plugin-dialog";
import { PanelLeft, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { HomeScreen } from "./components/home/HomeScreen";
import { CreateFromPrModal } from "./components/CreateFromPrModal";
import { NewWorkspaceModal } from "./components/NewWorkspaceModal";
import { Onboarding } from "./components/Onboarding";
import { ProjectSettingsDialog } from "./components/ProjectSettingsDialog";
import { SessionView } from "./components/session/SessionView";
import { SettingsScreen } from "./components/settings/SettingsScreen";
import { SessionsSidebar } from "./components/shell/SessionsSidebar";
import { useAppRouter } from "./hooks/useAppRouter";
import { EmptyState } from "./components/ui/empty-state";
import { useDesktopBehaviors } from "./hooks/useDesktopBehaviors";
import { GitHubProvider } from "./hooks/useGitHub";
import { useShortcuts } from "./hooks/useShortcuts";
import { WorkspaceDataProvider } from "./hooks/useWorkspaceData";
import {
  addProject,
  createQuickChat,
  createWorkspace,
  createWorkspaceFromPr,
  listProjects,
  listWorkspaces,
  openDevtools,
  probeEnvironment,
  removeWorkspace,
  renameWorkspace,
} from "./lib/api";
import { type EnvReport, type ProjectView, type Workspace } from "./lib/types";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; env: EnvReport }
  | { kind: "blocked"; env: EnvReport };

function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [rechecking, setRechecking] = useState(false);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [quickChats, setQuickChats] = useState<Workspace[]>([]);
  // All screen changes flow through the router (also feeds telemetry).
  const router = useAppRouter();
  const { view, selectedId, settingsTab } = router;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const [branchModalProject, setBranchModalProject] =
    useState<ProjectView | null>(null);
  const [prModalProject, setPrModalProject] = useState<ProjectView | null>(
    null,
  );
  const [settingsProject, setSettingsProject] = useState<ProjectView | null>(
    null,
  );

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
    // Quick chats live in the same registry but under no project, so they
    // come from the flat workspace list rather than the project views.
    const [projs, workspaces] = await Promise.all([
      listProjects(),
      listWorkspaces(),
    ]);
    setProjects(projs);
    setQuickChats(workspaces.filter((w) => w.kind === "QuickChat"));
  }, []);

  const pickProject = useCallback(async () => {
    const dir = await open({
      directory: true,
      multiple: false,
      title: "Select a git repository",
    });
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

  const allWorkspaces = useMemo(
    () => [...projects.flatMap((p) => p.workspaces), ...quickChats],
    [projects, quickChats],
  );
  const selected = selectedId
    ? (allWorkspaces.find((w) => w.id === selectedId) ?? null)
    : null;
  const selectedProject = selected
    ? (projects.find((p) => p.id === selected.project_id) ?? null)
    : null;

  // The backend supervisor keeps the active (and all autofix-enabled) servers
  // warm now — no frontend heartbeat needed.

  const openSession = useCallback(
    (w: Workspace) => router.openSession(w.id),
    [router],
  );

  const onRenamed = useCallback(
    async (workspaceId: string, name: string) => {
      await renameWorkspace(workspaceId, name);
      await refreshProjects();
    },
    [refreshProjects],
  );

  const createSession = useCallback(
    async (projectId: string, base: string | undefined, prompt: string) => {
      try {
        const ws = await createWorkspace(projectId, base, prompt || undefined);
        await refreshProjects();
        openSession(ws);
      } catch (e) {
        toast.error("Could not create session", { description: String(e) });
      }
    },
    [refreshProjects, openSession],
  );

  const quickCreate = useCallback(
    async (project: ProjectView) => {
      try {
        const ws = await createWorkspace(project.id);
        await refreshProjects();
        openSession(ws);
      } catch (e) {
        toast.error("Could not create session", { description: String(e) });
      }
    },
    [refreshProjects, openSession],
  );

  const checkoutPr = useCallback(
    async (projectId: string, prNumber: number) => {
      try {
        const ws = await createWorkspaceFromPr(projectId, prNumber);
        await refreshProjects();
        openSession(ws);
      } catch (e) {
        toast.error("Could not check out PR", { description: String(e) });
      }
    },
    [refreshProjects, openSession],
  );

  const newQuickChat = useCallback(
    async (prompt?: string) => {
      try {
        const ws = await createQuickChat(prompt);
        await refreshProjects();
        openSession(ws);
      } catch (e) {
        toast.error("Could not start quick chat", { description: String(e) });
      }
    },
    [refreshProjects, openSession],
  );

  const removeQuickChat = useCallback(
    async (id: string) => {
      try {
        // Force: the scratch dir is app-managed and has no git state to lose.
        await removeWorkspace(id, true);
        router.closeSession(id);
        await refreshProjects();
      } catch (e) {
        toast.error("Could not delete quick chat", { description: String(e) });
      }
    },
    [router, refreshProjects],
  );

  useShortcuts({
    toggleLeft: () => setSidebarCollapsed((c) => !c),
    toggleRight: () => {},
    openSettings: () => router.openSettings("general"),
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
    return (
      <Onboarding env={phase.env} onRecheck={check} rechecking={rechecking} />
    );
  }

  return (
    <GitHubProvider>
      <WorkspaceDataProvider
        activeWorkspaceId={view === "session" ? selectedId : null}
      >
        <div className="relative flex h-screen bg-background text-foreground">
          <div
            className={cn(
              "shrink-0 overflow-hidden transition-[width,opacity] duration-500 ease-out",
              sidebarCollapsed ? "w-0 opacity-0" : "w-[264px] opacity-100",
            )}
          >
            <SessionsSidebar
              view={view}
              onNavigate={router.navigate}
              onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
              onOpenSettings={() => router.openSettings("general")}
              onOpenAccounts={() => router.openSettings("accounts")}
              projects={projects}
              quickChats={quickChats}
              selectedWorkspaceId={view === "session" ? selectedId : null}
              onSelectWorkspace={openSession}
              onProjectsChanged={refreshProjects}
              onRenamed={onRenamed}
              onQuickCreate={(p) => void quickCreate(p)}
              onNewFromBranch={setBranchModalProject}
              onNewFromPr={setPrModalProject}
              onNewQuickChat={() => void newQuickChat()}
              onRemoveQuickChat={removeQuickChat}
              onAddProject={() => void pickProject()}
              onOpenProjectSettings={setSettingsProject}
            />
          </div>

          <button
            onClick={() => setSidebarCollapsed(false)}
            title="Show sidebar ⌘B"
            className={cn(
              "absolute left-[80px] top-2 z-20 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-all duration-200 ease-out hover:bg-accent hover:text-foreground",
              sidebarCollapsed
                ? "scale-100 opacity-100 delay-200"
                : "pointer-events-none scale-75 opacity-0",
            )}
          >
            <PanelLeft className="size-4" />
          </button>

          <main className="min-w-0 flex-1 overflow-hidden">
            {view === "session" && selected ? (
              <SessionView
                key={selected.id}
                workspace={selected}
                project={selectedProject}
                onRenamed={onRenamed}
                sidebarCollapsed={sidebarCollapsed}
                onManageModels={() => router.openSettings("models")}
              />
            ) : view === "search" ? (
              <SearchScreen
                projects={projects}
                quickChats={quickChats}
                onSelect={openSession}
              />
            ) : (
              <HomeScreen
                projects={projects}
                onCreateSession={(pid, base, prompt) =>
                  void createSession(pid, base, prompt)
                }
                onQuickChat={(prompt) => void newQuickChat(prompt)}
                onAddProject={() => void pickProject()}
                onCheckoutPr={(pid, prNumber) => void checkoutPr(pid, prNumber)}
                onOpenAccounts={() => router.openSettings("accounts")}
              />
            )}
          </main>

          <SettingsScreen
            open={settingsTab !== null}
            onOpenChange={(o) =>
              o ? router.openSettings() : router.closeSettings()
            }
            initialTab={settingsTab ?? "general"}
            onTabChange={router.settingsTabChanged}
            projects={projects}
            onProjectsChanged={refreshProjects}
            onAddProject={() => void pickProject()}
            onOpenProjectSettings={(p) => {
              router.closeSettings();
              setSettingsProject(p);
            }}
          />

          {branchModalProject && (
            <NewWorkspaceModal
              project={branchModalProject}
              onClose={() => setBranchModalProject(null)}
              onCreated={(ws) => {
                void refreshProjects().then(() => openSession(ws));
              }}
            />
          )}

          {prModalProject && (
            <CreateFromPrModal
              project={prModalProject}
              onClose={() => setPrModalProject(null)}
              onCreated={(ws) => {
                void refreshProjects().then(() => openSession(ws));
              }}
            />
          )}

          {settingsProject && (
            <ProjectSettingsDialog
              project={settingsProject}
              open
              onOpenChange={(o) => !o && setSettingsProject(null)}
              onUpdated={(updated) => {
                setProjects((prev) =>
                  prev.map((p) =>
                    p.id === updated.id
                      ? { ...updated, workspaces: p.workspaces }
                      : p,
                  ),
                );
                setSettingsProject((cur) =>
                  cur?.id === updated.id
                    ? { ...updated, workspaces: cur.workspaces }
                    : cur,
                );
              }}
              workspaceId={
                selected?.id ?? settingsProject.workspaces[0]?.id ?? ""
              }
            />
          )}
        </div>
      </WorkspaceDataProvider>
    </GitHubProvider>
  );
}

function SearchScreen({
  projects,
  quickChats,
  onSelect,
}: {
  projects: ProjectView[];
  quickChats: Workspace[];
  onSelect: (w: Workspace) => void;
}) {
  const [q, setQ] = useState("");
  const all = useMemo(
    () => [
      ...quickChats.map((w) => ({ w, project: "Quick chats" })),
      ...projects.flatMap((p) =>
        p.workspaces.map((w) => ({ w, project: p.name })),
      ),
    ],
    [projects, quickChats],
  );
  const term = q.trim().toLowerCase();
  const results = term
    ? all.filter(
        ({ w, project }) =>
          (w.name ?? w.branch ?? "").toLowerCase().includes(term) ||
          project.toLowerCase().includes(term),
      )
    : all;

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col px-6 pt-[8vh]">
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 transition-colors duration-150 focus-within:border-ring">
        <Search className="size-4 text-muted-foreground" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search sessions and projects…"
          className="flex-1 select-text bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        {results.length === 0 ? (
          <EmptyState
            className="py-16"
            icon={<Search className="size-6 text-muted-foreground/60" />}
          >
            No matching sessions.
          </EmptyState>
        ) : (
          <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {results.map(({ w, project }) => (
              <button
                key={w.id}
                onClick={() => onSelect(w)}
                className="flex items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate">
                  {w.name ?? w.branch ?? "session"}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {project}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
