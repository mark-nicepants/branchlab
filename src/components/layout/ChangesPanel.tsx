import { FileDiff } from "lucide-react";
import type { Workspace } from "../../lib/types";

interface Props {
  workspace: Workspace | null;
}

/**
 * Right panel. For now a structured placeholder matching Polyscope's layout
 * (Changes / Files / History tabs, Local / Base toggle); the live diff viewer
 * lands in a later milestone.
 */
export function ChangesPanel({ workspace }: Props) {
  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex items-center gap-4 border-b border-border px-4 py-2.5 text-sm">
        <span className="font-medium">Changes</span>
        <span className="text-muted-foreground">Files</span>
        <span className="text-muted-foreground">History</span>
      </div>
      <div className="flex items-center gap-3 border-b border-border px-4 py-1.5 text-xs">
        <span className="font-medium">Local</span>
        <span className="text-muted-foreground">Base</span>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <FileDiff className="size-6 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">No changes yet</p>
        <p className="text-xs text-muted-foreground/70">
          {workspace
            ? "Files the agent edits in this workspace show up here as a diff."
            : "Select a workspace to see its changes."}
        </p>
      </div>
    </div>
  );
}
