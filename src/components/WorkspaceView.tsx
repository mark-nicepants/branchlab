import { useEffect, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { startServer } from "../lib/api";
import { OpencodeClient } from "../lib/opencode";
import type { Workspace } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Chat } from "./Chat";
import { ChangesView } from "./center/ChangesView";
import { ConfigView } from "./center/ConfigView";
import { cn } from "@/lib/utils";

export type CenterTab = "activity" | "changes" | "config";

interface Props {
  workspace: Workspace;
  onRenamed: (workspaceId: string, name: string) => void;
  tab: CenterTab;
  onTabChange: (tab: CenterTab) => void;
  focusedFile: string | null;
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
  onMarkAllViewed: (paths: string[]) => void;
}

type State =
  | { kind: "starting" }
  | { kind: "ready"; baseUrl: string }
  | { kind: "error"; message: string };

export function WorkspaceView({
  workspace,
  onRenamed,
  tab,
  onTabChange,
  focusedFile,
  viewed,
  onToggleViewed,
  onMarkAllViewed,
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
  }, [workspace.id, attempt]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1 border-b border-border px-3 text-sm">
        <Tab active={tab === "activity"} onClick={() => onTabChange("activity")}>
          Activity
        </Tab>
        <Tab active={tab === "changes"} onClick={() => onTabChange("changes")}>
          Changes
        </Tab>
        <Tab active={tab === "config"} onClick={() => onTabChange("config")}>
          Config
        </Tab>
      </header>

      {tab === "config" ? (
        <ConfigView
          workspaceId={workspace.id}
          baseUrl={state.kind === "ready" ? state.baseUrl : null}
          onRestarted={() => setAttempt((a) => a + 1)}
        />
      ) : tab === "changes" ? (
        <ChangesView
          workspaceId={workspace.id}
          baseBranch={workspace.base_branch}
          focusedFile={focusedFile}
          viewed={viewed}
          onToggleViewed={onToggleViewed}
          onMarkAllViewed={onMarkAllViewed}
        />
      ) : state.kind === "ready" ? (
        <Chat key={workspace.id} workspace={workspace} baseUrl={state.baseUrl} onRenamed={onRenamed} />
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
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "border-b-2 px-2 py-2.5 text-sm",
        active
          ? "border-primary font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
