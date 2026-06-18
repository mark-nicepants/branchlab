import { useEffect, useState } from "react";
import { Loader2, TriangleAlert, X } from "lucide-react";
import { startServer } from "../lib/api";
import { OpencodeClient } from "../lib/opencode";
import type { ContextInfo, ProjectView, Workspace } from "../lib/types";
import { Button } from "@/components/ui/button";
import { TabBarItem } from "@/components/ui/tab-bar";
import { Chat, type WorkspaceAction } from "./Chat";
import { CommitButton } from "./CommitButton";
import { ChangesView } from "./center/ChangesView";
import { FileView } from "./center/FileView";

export type CenterTab = "activity" | "changes" | "file";

interface Props {
  workspace: Workspace;
  project: ProjectView;
  onRenamed: (workspaceId: string, name: string) => void;
  tab: CenterTab;
  onTabChange: (tab: CenterTab) => void;
  focusedFile: string | null;
  viewerFile: string | null;
  onCloseFile: () => void;
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
  onMarkAllViewed: (paths: string[]) => void;
  onContext: (info: ContextInfo | null) => void;
  /** Bumped to force a server reconnect (e.g. after editing config). */
  reloadNonce: number;
}

type State =
  | { kind: "starting" }
  | { kind: "ready"; baseUrl: string }
  | { kind: "error"; message: string };

export function WorkspaceView({
  workspace,
  project,
  onRenamed,
  tab,
  onTabChange,
  focusedFile,
  viewerFile,
  onCloseFile,
  viewed,
  onToggleViewed,
  onMarkAllViewed,
  onContext,
  reloadNonce,
}: Props) {
  const [state, setState] = useState<State>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "starting" });

    (async () => {
      try {
        const info = await startServer(workspace.id);
        const client = new OpencodeClient(info.base_url);
        let ok = false;
        for (let i = 0; i < 40 && !cancelled; i++) {
          try {
            await client.health();
            ok = true;
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 150));
          }
        }
        if (cancelled) return;
        setState(
          ok ? { kind: "ready", baseUrl: info.base_url } : { kind: "error", message: "server did not become healthy" },
        );
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: String(e) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspace.id, attempt, reloadNonce]);

  const dispatchAction = (action: WorkspaceAction) => {
    const el = document.getElementById("workspace-actions");
    if (!el) return;
    el.dispatchEvent(new CustomEvent("workspace-action", { detail: action }));
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-3 text-sm">
        <TabBarItem active={tab === "activity"} onClick={() => onTabChange("activity")}>
          Activity
        </TabBarItem>
        <TabBarItem active={tab === "changes"} onClick={() => onTabChange("changes")}>
          Changes
        </TabBarItem>
        {viewerFile && (
          <TabBarItem active={tab === "file"} onClick={() => onTabChange("file")}>
            <span className="flex items-center gap-1.5">
              <span className="max-w-40 truncate" title={viewerFile}>
                {viewerFile.split("/").pop()}
              </span>
              <span
                role="button"
                tabIndex={0}
                className="rounded-sm p-0.5 hover:bg-accent"
                title="Close file"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseFile();
                }}
              >
                <X className="size-3" />
              </span>
            </span>
          </TabBarItem>
        )}
        <div className="ml-auto">
          {workspace.kind === "Worktree" && state.kind === "ready" && (
            <CommitButton workspace={workspace} project={project} onAction={dispatchAction} />
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "file" && viewerFile ? (
          <FileView workspaceId={workspace.id} file={viewerFile} />
        ) : tab === "changes" ? (
          <ChangesView
            workspaceId={workspace.id}
            focusedFile={focusedFile}
            viewed={viewed}
            onToggleViewed={onToggleViewed}
            onMarkAllViewed={onMarkAllViewed}
          />
        ) : state.kind === "ready" ? (
          <Chat
            key={workspace.id}
            workspace={workspace}
            baseUrl={state.baseUrl}
            onRenamed={onRenamed}
            onContext={onContext}
            onAction={dispatchAction}
          />
        ) : state.kind === "error" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm">
            <TriangleAlert className="size-6 text-destructive" />
            <p className="text-muted-foreground">Could not start the workspace.</p>
            <Button variant="outline" size="sm" onClick={() => setAttempt((a) => a + 1)}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Creating workspace…
          </div>
        )}
      </div>
      <div id="workspace-actions" className="hidden" />
    </div>
  );
}


