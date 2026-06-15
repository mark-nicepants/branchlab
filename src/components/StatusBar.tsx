import { GitBranch } from "lucide-react";
import { workspaceLabel, type Workspace } from "../lib/types";

interface Props {
  workspace: Workspace | null;
  workspaceCount: number;
}

export function StatusBar({ workspace, workspaceCount }: Props) {
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-sidebar px-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        {workspace && (
          <span className="flex items-center gap-1">
            <GitBranch className="size-3" />
            {workspaceLabel(workspace)}
          </span>
        )}
      </div>
      <span>{workspaceCount} workspaces</span>
    </footer>
  );
}
