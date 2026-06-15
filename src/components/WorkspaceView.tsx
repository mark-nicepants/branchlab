import { useEffect, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { startServer } from "../lib/api";
import { OpencodeClient } from "../lib/opencode";
import type { Workspace } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Chat } from "./Chat";

interface Props {
  workspace: Workspace;
  onRenamed: (workspaceId: string, name: string) => void;
}

type State =
  | { kind: "starting" }
  | { kind: "ready"; baseUrl: string }
  | { kind: "error"; message: string };

/**
 * Owns the per-workspace server lifecycle. The server is an internal detail —
 * we surface it only as a brief "Creating workspace…" state and, if it fails,
 * an error with a retry. No start/stop controls.
 */
export function WorkspaceView({ workspace, onRenamed }: Props) {
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
        setState(ok ? { kind: "ready", baseUrl: info.base_url } : { kind: "error", message: "server did not become healthy" });
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
      <header className="flex items-center gap-4 border-b border-border px-4 py-2.5 text-sm">
        <span className="font-medium">Activity</span>
      </header>

      {state.kind === "ready" ? (
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
