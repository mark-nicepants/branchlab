import { useCallback, useEffect, useState } from "react";
import { listProjects, probeEnvironment, touchServer } from "./lib/api";
import type { EnvReport, ProjectView, Workspace } from "./lib/types";
import { Onboarding } from "./components/Onboarding";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceView } from "./components/WorkspaceView";
import { FleetDashboard } from "./components/FleetDashboard";
import { NewWorktreeModal } from "./components/NewWorktreeModal";
import "./App.css";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; env: EnvReport }
  | { kind: "blocked"; env: EnvReport };

function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [rechecking, setRechecking] = useState(false);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [selected, setSelected] = useState<Workspace | null>(null);
  const [worktreeProject, setWorktreeProject] = useState<ProjectView | null>(null);

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

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    if (phase.kind === "ready") void refreshProjects();
  }, [phase.kind, refreshProjects]);

  // Heartbeat: while a workspace is open, keep its server from being reaped.
  useEffect(() => {
    if (!selected) return;
    void touchServer(selected.id);
    const t = setInterval(() => void touchServer(selected.id), 60_000);
    return () => clearInterval(t);
  }, [selected]);

  if (phase.kind === "loading") {
    return (
      <div className="screen center">
        <p className="muted">Checking environment…</p>
      </div>
    );
  }

  if (phase.kind === "blocked") {
    return <Onboarding env={phase.env} onRecheck={check} rechecking={rechecking} />;
  }

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        selectedWorkspaceId={selected?.id ?? null}
        onSelectWorkspace={setSelected}
        onProjectsChanged={refreshProjects}
        onShowFleet={() => setSelected(null)}
        onNewWorktree={setWorktreeProject}
      />
      <main className="main">
        {selected ? (
          <WorkspaceView key={selected.id} workspace={selected} />
        ) : (
          <FleetDashboard projects={projects} onOpenWorkspace={setSelected} />
        )}
      </main>

      {worktreeProject && (
        <NewWorktreeModal
          project={worktreeProject}
          onClose={() => setWorktreeProject(null)}
          onCreated={() => void refreshProjects()}
        />
      )}
    </div>
  );
}

export default App;
