import { useEffect, useState } from "react";
import type { Layout } from "react-resizable-panels";
import { restartServer, serverStatus } from "../lib/api";
import type { ContextInfo, ServerInfo, Workspace } from "../lib/types";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { OpencodeStatus } from "./OpencodeStatus";
import { cn } from "@/lib/utils";

interface Props {
  layout: Layout;
  projectCount: number;
  workspaceCount: number;
  workspace: Workspace | null;
  context: ContextInfo | null;
  opencodeVersion: string | null;
  /** Kept for API compatibility; config restart is now handled by ProjectSettingsDialog. */
  onConfigRestarted?: () => void;
}

/**
 * Three-segment status bar whose widths track the resizable panel layout, so
 * each panel "owns" its slice. Left = sidebar summary, center = active
 * workspace (context window) and server controls. Right is empty under the
 * changes panel. Hovering a segment opens a richer card.
 */
export function StatusBar({
  layout,
  projectCount,
  workspaceCount,
  workspace,
  context,
  opencodeVersion,
}: Props) {
  const [server, setServer] = useState<ServerInfo | null>(null);

  useEffect(() => {
    if (!workspace) {
      setServer(null);
      return;
    }
    const poll = () => serverStatus(workspace.id).then(setServer).catch(() => {});
    void poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [workspace?.id]);

  const pct = context && context.max > 0 ? Math.round((context.used / context.max) * 100) : null;

  return (
    <footer className="flex h-7 shrink-0 border-t border-border bg-sidebar text-xs text-muted-foreground">
      <Segment basis={layout.left}>
        <HoverCard openDelay={150}>
          <HoverCardTrigger className="truncate">
            {projectCount} {projectCount === 1 ? "project" : "projects"}
          </HoverCardTrigger>
          <HoverCardContent side="top" align="start" className="w-56 rounded-none text-xs">
            <div className="font-medium text-foreground">Projects</div>
            <p className="mt-1 text-muted-foreground">
              {projectCount} projects · {workspaceCount} workspaces
            </p>
          </HoverCardContent>
        </HoverCard>
      </Segment>

      <Segment basis={layout.center} bordered>
        <div className="min-w-0 flex-1 truncate">
          {workspace ? (
            pct !== null ? (
              <HoverCard openDelay={150}>
                <HoverCardTrigger className={cn("truncate", pct >= 80 && "text-warning")}>
                  {pct}% context
                </HoverCardTrigger>
                <HoverCardContent side="top" align="center" className="w-56 rounded-none text-xs">
                  <div className="font-medium text-foreground">Context window</div>
                  <p className="mt-1 text-muted-foreground">
                    {context!.used.toLocaleString()} / {context!.max.toLocaleString()} tokens
                  </p>
                </HoverCardContent>
              </HoverCard>
            ) : (
              <span className="truncate">Ready</span>
            )
          ) : (
            <span className="truncate">{workspaceCount} workspaces</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <OpencodeStatus
            baseUrl={server?.base_url ?? null}
            version={opencodeVersion}
            workspace={!!workspace}
            onRestart={() => workspace && void restartServer(workspace.id).then(setServer)}
          />
        </div>
      </Segment>

      <Segment basis={layout.right} bordered />
    </footer>
  );
}

function Segment({
  basis,
  bordered,
  children,
}: {
  basis: number | undefined;
  bordered?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{ flexBasis: `${basis ?? 0}%`, flexGrow: 0, flexShrink: 0 }}
      className={cn(
        "flex items-center gap-2 overflow-hidden px-3",
        bordered && "border-l border-border",
      )}
    >
      {children}
    </div>
  );
}
