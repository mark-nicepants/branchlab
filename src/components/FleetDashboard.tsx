import { useCallback, useEffect, useState } from "react";
import { listServers, startServer, stopServer, workspaceDiffStat } from "../lib/api";
import type { DiffStat, ProjectView, Workspace } from "../lib/types";

interface Props {
  projects: ProjectView[];
  onOpenWorkspace: (w: Workspace) => void;
}

interface Row {
  workspace: Workspace;
  projectName: string;
}

/**
 * The fleet view: every workspace across every project as a card, with live
 * server status and uncommitted-change stats. This is the product's soul —
 * monitoring and switching between parallel agents.
 */
export function FleetDashboard({ projects, onOpenWorkspace }: Props) {
  const rows: Row[] = projects.flatMap((p) =>
    p.workspaces.map((w) => ({ workspace: w, projectName: p.name })),
  );

  const [running, setRunning] = useState<Set<string>>(new Set());
  const [diffs, setDiffs] = useState<Record<string, DiffStat>>({});

  const poll = useCallback(async () => {
    const servers = await listServers().catch(() => []);
    setRunning(new Set(servers.map((s) => s.workspace_id)));
    // Diff stats are cheap git calls; fetch for all known workspaces.
    const entries = await Promise.all(
      rows.map(async (r) => [r.workspace.id, await workspaceDiffStat(r.workspace.id)] as const),
    );
    setDiffs(Object.fromEntries(entries));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), 4000);
    return () => clearInterval(t);
  }, [poll]);

  return (
    <div className="fleet">
      <header className="fleet-header">
        <h1>Fleet</h1>
        <span className="muted small">
          {running.size} running · {rows.length} workspaces
        </span>
      </header>

      {rows.length === 0 && (
        <p className="muted" style={{ padding: 24 }}>
          No workspaces yet. Add a project and create a worktree to start a fleet.
        </p>
      )}

      <div className="fleet-grid">
        {rows.map(({ workspace, projectName }) => {
          const isRunning = running.has(workspace.id);
          const diff = diffs[workspace.id];
          return (
            <div
              key={workspace.id}
              className="fleet-card"
              onClick={() => onOpenWorkspace(workspace)}
            >
              <div className="fleet-card-top">
                <span className="muted xsmall">{projectName}</span>
                <span className={`dot ${isRunning ? "on" : "off"}`} title={isRunning ? "running" : "stopped"} />
              </div>
              <div className="ws-branch fleet-branch">{workspace.branch ?? "—"}</div>
              <div className="muted xsmall">{workspace.kind === "Base" ? "base repo" : "worktree"}</div>

              <div className="fleet-diff">
                {diff && (diff.files > 0 ? (
                  <span>
                    {diff.files} files <span className="ins">+{diff.insertions}</span>{" "}
                    <span className="del">-{diff.deletions}</span>
                  </span>
                ) : (
                  <span className="muted">clean</span>
                ))}
              </div>

              <div className="fleet-actions" onClick={(e) => e.stopPropagation()}>
                {isRunning ? (
                  <button className="ghost xsmall" onClick={() => void stopServer(workspace.id).then(poll)}>
                    Stop
                  </button>
                ) : (
                  <button className="ghost xsmall" onClick={() => void startServer(workspace.id).then(poll)}>
                    Start
                  </button>
                )}
                <button className="ghost xsmall" onClick={() => onOpenWorkspace(workspace)}>
                  Open →
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
