import { useCallback, useEffect, useState } from "react";
import { workspaceDiffStat } from "../lib/api";
import { workspaceLabel, type DiffStat, type ProjectView, type Workspace } from "../lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";

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
 * uncommitted-change stats. Server/connection state is intentionally hidden —
 * it's an internal detail.
 */
export function FleetDashboard({ projects, onOpenWorkspace }: Props) {
  const rows: Row[] = projects.flatMap((p) =>
    p.workspaces.map((w) => ({ workspace: w, projectName: p.name })),
  );

  const [diffs, setDiffs] = useState<Record<string, DiffStat>>({});

  const poll = useCallback(async () => {
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
    <div className="flex h-full flex-col">
      <header className="flex items-baseline gap-3 border-b border-border px-6 py-4">
        <h1 className="text-base font-semibold">Fleet</h1>
        <span className="text-xs text-muted-foreground">{rows.length} workspaces</span>
      </header>

      <ScrollArea className="flex-1">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            No workspaces yet. Add a project and create a workspace to start a fleet.
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-6">
            {rows.map(({ workspace, projectName }) => {
              const diff = diffs[workspace.id];
              return (
                <button
                  key={workspace.id}
                  className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-muted-foreground/40"
                  onClick={() => onOpenWorkspace(workspace)}
                >
                  <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    {projectName}
                  </span>
                  <span className="truncate text-sm font-medium">{workspaceLabel(workspace)}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {workspace.kind === "Base" ? "base repo" : "workspace"}
                  </span>
                  <span className="min-h-4 text-xs">
                    {diff &&
                      (diff.files > 0 ? (
                        <>
                          {diff.files} files <span className="text-primary">+{diff.insertions}</span>{" "}
                          <span className="text-destructive">−{diff.deletions}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">clean</span>
                      ))}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
