import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SectionLabel } from "@/components/ui/section-label";
import { FolderPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { workspaceDiffStat } from "../lib/api";
import { workspaceLabel, type DiffStat, type ProjectView, type Workspace } from "../lib/types";

interface Props {
  projects: ProjectView[];
  onOpenWorkspace: (w: Workspace) => void;
  onAddProject: () => void;
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
export function FleetDashboard({ projects, onOpenWorkspace, onAddProject }: Props) {
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

      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <div>
            <p className="text-sm font-medium">No projects yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Add a git repository to start your fleet of agent workspaces.
            </p>
          </div>
          <Button onClick={onAddProject} className="gap-2">
            <FolderPlus className="size-4" /> New project
          </Button>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-6">
            {rows.map(({ workspace, projectName }) => {
              const diff = diffs[workspace.id];
              return (
                <button
                  key={workspace.id}
                  className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-muted-foreground/40"
                  onClick={() => onOpenWorkspace(workspace)}
                >
                  <SectionLabel>{projectName}</SectionLabel>
                  <span className="truncate text-sm font-medium">{workspaceLabel(workspace)}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {workspace.kind === "Base" ? "base repo" : "workspace"}
                  </span>
                  <span className="min-h-4 text-xs">
                    {diff &&
                      (diff.files > 0 ? (
                        <>
                          {diff.files} files <span className="text-additions">+{diff.insertions}</span>{" "}
                          <span className="text-deletions">−{diff.deletions}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">clean</span>
                      ))}
                  </span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
