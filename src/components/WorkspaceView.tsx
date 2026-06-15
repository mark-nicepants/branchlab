import { useEffect, useState } from "react";
import { startServer, stopServer } from "../lib/api";
import { OpencodeClient } from "../lib/opencode";
import type { Workspace } from "../lib/types";
import { Chat } from "./Chat";

interface Props {
  workspace: Workspace;
}

type State =
  | { kind: "starting" }
  | { kind: "ready"; baseUrl: string; version: string }
  | { kind: "error"; message: string };

/**
 * Owns the per-workspace server lifecycle: asks the Rust ServerManager to
 * spawn `opencode serve` for this workspace's directory, waits for health,
 * then mounts the chat against the returned base URL.
 */
export function WorkspaceView({ workspace }: Props) {
  const [state, setState] = useState<State>({ kind: "starting" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "starting" });

    (async () => {
      try {
        const info = await startServer(workspace.id);
        const client = new OpencodeClient(info.base_url);
        // The listen line means it's bound, but confirm health before chat.
        let health: { version: string } | null = null;
        for (let i = 0; i < 40 && !cancelled; i++) {
          try {
            health = await client.health();
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 150));
          }
        }
        if (cancelled) return;
        if (!health) {
          setState({ kind: "error", message: "server did not become healthy" });
          return;
        }
        setState({ kind: "ready", baseUrl: info.base_url, version: health.version });
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: String(e) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspace.id]);

  return (
    <div className="workspace">
      <header className="workspace-header">
        <div>
          <strong>{workspace.branch ?? workspace.path}</strong>
          <span className="muted small kind-tag">{workspace.kind}</span>
        </div>
        <div className="workspace-status">
          {state.kind === "starting" && <span className="muted small">starting server…</span>}
          {state.kind === "ready" && (
            <span className="muted small">opencode {state.version} · port up</span>
          )}
          {state.kind === "error" && <span className="error-text small">{state.message}</span>}
          <button
            className="ghost small"
            onClick={() => void stopServer(workspace.id)}
            title="Stop this workspace's server"
          >
            Stop server
          </button>
        </div>
      </header>

      {state.kind === "ready" ? (
        <Chat key={workspace.id} baseUrl={state.baseUrl} />
      ) : (
        <div className="center" style={{ flex: 1 }}>
          <p className="muted">
            {state.kind === "error" ? "Could not start the server." : "Booting OpenCode…"}
          </p>
        </div>
      )}
    </div>
  );
}
