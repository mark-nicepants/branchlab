import { open } from "@tauri-apps/plugin-dialog";
import { addProject, removeProject, removeWorkspace } from "../lib/api";
import type { ProjectView, Workspace } from "../lib/types";

interface Props {
  projects: ProjectView[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (w: Workspace) => void;
  onProjectsChanged: () => void;
  onShowFleet: () => void;
  onNewWorktree: (project: ProjectView) => void;
}

export function Sidebar({
  projects,
  selectedWorkspaceId,
  onSelectWorkspace,
  onProjectsChanged,
  onShowFleet,
  onNewWorktree,
}: Props) {
  async function pickProject() {
    const dir = await open({ directory: true, multiple: false, title: "Select a git repository" });
    if (typeof dir !== "string") return;
    try {
      await addProject(dir);
      onProjectsChanged();
    } catch (e) {
      alert(`Could not add project: ${e}`);
    }
  }

  async function removeWt(w: Workspace) {
    if (!confirm(`Remove worktree "${w.branch}"? This deletes the worktree directory.`)) return;
    try {
      await removeWorkspace(w.id, false);
      onProjectsChanged();
    } catch (e) {
      // Likely uncommitted changes — offer a forced removal.
      if (confirm(`${e}\n\nForce-remove anyway? Uncommitted changes will be lost.`)) {
        await removeWorkspace(w.id, true).then(onProjectsChanged).catch((e2) => alert(String(e2)));
      }
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="logo">OpenScope</span>
        <button className="ghost small" onClick={() => void pickProject()}>
          + Project
        </button>
      </div>

      <button className="fleet-nav" onClick={onShowFleet}>
        ▦ Fleet
      </button>

      <div className="project-list">
        {projects.length === 0 && (
          <p className="muted small" style={{ padding: "0 12px" }}>
            No projects yet. Add a git repository to begin.
          </p>
        )}
        {projects.map((p) => (
          <div key={p.id} className="project">
            <div className="project-name">
              <span>{p.name}</span>
              <span className="project-actions">
                <button className="ghost xsmall" title="New worktree" onClick={() => onNewWorktree(p)}>
                  + wt
                </button>
                <button
                  className="ghost xsmall"
                  title="Remove project"
                  onClick={() => {
                    if (confirm(`Remove project "${p.name}"? (does not delete files)`)) {
                      void removeProject(p.id).then(onProjectsChanged);
                    }
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
            {p.workspaces.map((w) => (
              <div
                key={w.id}
                className={`workspace-item ${w.id === selectedWorkspaceId ? "active" : ""}`}
              >
                <button className="workspace-item-main" onClick={() => onSelectWorkspace(w)}>
                  <span className="ws-branch">{w.branch ?? "—"}</span>
                  <span className="muted xsmall">{w.kind === "Base" ? "repo" : "worktree"}</span>
                </button>
                {w.kind === "Worktree" && (
                  <button className="ghost xsmall" title="Remove worktree" onClick={() => void removeWt(w)}>
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
