import { useCallback, useState } from "react";
import { ArrowLeft, Code2, Columns2, Loader2, TriangleAlert } from "lucide-react";
import { openExternal, restartServer, startServer } from "../../lib/api";
import { OpencodeClient } from "../../lib/opencode";
import type { ContextInfo, ProjectView, Workspace } from "../../lib/types";
import { workspaceLabel } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Chat, type WorkspaceAction } from "../Chat";
import { CommitButton } from "../CommitButton";
import { ChangesPanel } from "../layout/ChangesPanel";
import { ChangesView } from "../center/ChangesView";
import { FileView } from "../center/FileView";
import { usePreferences } from "../PreferencesProvider";
import { useCancellableEffect } from "../../hooks/useCancellableEffect";
import { cn } from "@/lib/utils";

interface Props {
  workspace: Workspace;
  project: ProjectView | null;
  onRenamed: (workspaceId: string, name: string) => void;
  /** Bumped to force a server reconnect (e.g. after editing config). */
  reloadNonce?: number;
  /** When the sidebar is collapsed, pad the header to clear traffic lights. */
  sidebarCollapsed?: boolean;
}

type State =
  | { kind: "starting" }
  | { kind: "ready"; baseUrl: string }
  | { kind: "error"; message: string };

/** Right-panel content mode. */
type PanelMode =
  | { kind: "list" }
  | { kind: "diff"; file: string | null }
  | { kind: "file"; file: string };

/**
 * A session = one workspace's opencode server + streaming chat, with an
 * on-demand git changes panel that slides in from the right. Quick chats have
 * no git, so the changes panel and commit actions are hidden for them.
 */
export function SessionView({ workspace, project, onRenamed, reloadNonce = 0, sidebarCollapsed = false }: Props) {
  const { prefs } = usePreferences();
  const [state, setState] = useState<State>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);
  const [pendingAction, setPendingAction] = useState<WorkspaceAction | null>(null);
  const [context, setContext] = useState<ContextInfo | null>(null);

  const isQuickChat = workspace.kind === "QuickChat";
  const isWorktree = workspace.kind === "Worktree";
  const baseUrl = state.kind === "ready" ? state.baseUrl : null;

  const [changesOpen, setChangesOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>({ kind: "list" });
  const [viewed, setViewed] = useState<Set<string>>(new Set());

  const toggleViewed = useCallback((path: string) => {
    setViewed((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }, []);
  const markAllViewed = useCallback((paths: string[]) => setViewed(new Set(paths)), []);

  useCancellableEffect(
    async (cancelled) => {
      setState({ kind: "starting" });
      try {
        const info = await startServer(workspace.id);
        const client = new OpencodeClient(info.base_url);
        let ok = false;
        for (let i = 0; i < 40 && !cancelled(); i++) {
          try {
            await client.health();
            ok = true;
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 150));
          }
        }
        if (cancelled()) return;
        setState(ok ? { kind: "ready", baseUrl: info.base_url } : { kind: "error", message: "server did not become healthy" });
      } catch (e) {
        if (!cancelled()) setState({ kind: "error", message: String(e) });
      }
    },
    [workspace.id, attempt, reloadNonce],
  );

  const restart = useCallback(() => {
    setState({ kind: "starting" });
    void restartServer(workspace.id)
      .then(() => setAttempt((a) => a + 1))
      .catch(() => setAttempt((a) => a + 1));
  }, [workspace.id]);

  const pct = context && context.max > 0 ? Math.round((context.used / context.max) * 100) : null;

  return (
    <div className="flex h-full flex-col">
      {/* Session header */}
      <header
        data-tauri-drag-region
        className={cn("flex h-11 shrink-0 items-center gap-2 border-b border-border px-4", sidebarCollapsed && "pl-[120px]")}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
          {project && <span className="shrink-0 text-muted-foreground">{project.name}</span>}
          {project && <span className="text-muted-foreground/40">/</span>}
          <span className="min-w-0 truncate font-medium" title={workspaceLabel(workspace)}>
            {workspaceLabel(workspace)}
          </span>
          {pct !== null && (
            <HoverCard openDelay={150}>
              <HoverCardTrigger className={cn("ml-2 shrink-0 text-xs", pct >= 80 ? "text-warning" : "text-muted-foreground")}>
                {pct}% context
              </HoverCardTrigger>
              <HoverCardContent side="bottom" align="start" className="w-56 text-xs">
                <div className="font-medium text-foreground">Context window</div>
                <p className="mt-1 text-muted-foreground">
                  {context!.used.toLocaleString()} / {context!.max.toLocaleString()} tokens
                </p>
              </HoverCardContent>
            </HoverCard>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isWorktree && project && state.kind === "ready" && (
            <CommitButton workspace={workspace} project={project} onAction={setPendingAction} />
          )}
          {!isQuickChat && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => openExternal(workspace.path, prefs.editorApp).catch(() => {})}
                >
                  <Code2 className="size-3.5" /> Open
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open in {prefs.editorApp}</TooltipContent>
            </Tooltip>
          )}
          {!isQuickChat && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(changesOpen && "bg-accent text-accent-foreground")}
                  onClick={() => setChangesOpen((o) => !o)}
                >
                  <Columns2 className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Toggle changes</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      {/* Body: chat + sliding changes panel */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {state.kind === "ready" ? (
            <Chat
              key={workspace.id}
              workspace={workspace}
              baseUrl={state.baseUrl}
              onRenamed={onRenamed}
              onContext={setContext}
              pendingAction={pendingAction}
              onActionConsumed={() => setPendingAction(null)}
            />
          ) : state.kind === "error" ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm">
              <TriangleAlert className="size-6 text-destructive" />
              <p className="text-muted-foreground">Could not start the session.</p>
              <Button variant="outline" size="sm" onClick={() => setAttempt((a) => a + 1)}>
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Starting session…
            </div>
          )}
        </div>

        {!isQuickChat && (
          <div
            className={cn(
              "shrink-0 overflow-hidden border-l border-border transition-[width] duration-200 ease-out",
              changesOpen ? "w-[460px]" : "w-0 border-l-0",
            )}
          >
            <div className="flex h-full w-[460px] flex-col">
              {panelMode.kind === "list" ? (
                <ChangesPanel
                  workspace={workspace}
                  viewed={viewed}
                  onToggleViewed={toggleViewed}
                  onOpenFile={(path) => setPanelMode({ kind: "diff", file: path })}
                  onViewFile={(path) => setPanelMode({ kind: "file", file: path })}
                  baseUrl={baseUrl}
                  onRestart={restart}
                />
              ) : (
                <>
                  <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2 text-xs">
                    <Button variant="ghost" size="icon-sm" onClick={() => setPanelMode({ kind: "list" })}>
                      <ArrowLeft className="size-3.5" />
                    </Button>
                    <span className="min-w-0 flex-1 truncate font-mono" title={panelMode.file ?? undefined}>
                      {panelMode.file ?? "Changes"}
                    </span>
                  </div>
                  <div className="min-h-0 flex-1">
                    {panelMode.kind === "diff" ? (
                      <ChangesView
                        workspaceId={workspace.id}
                        focusedFile={panelMode.file}
                        viewed={viewed}
                        onToggleViewed={toggleViewed}
                        onMarkAllViewed={markAllViewed}
                      />
                    ) : (
                      <FileView workspaceId={workspace.id} file={panelMode.file} />
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
