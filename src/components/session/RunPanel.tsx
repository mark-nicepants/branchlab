import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ExternalLink, Play, RotateCw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  openExternal,
  runStart,
  runState as fetchRunState,
  runStop,
} from "../../lib/api";
import { onWorkspaceRun, onWorkspaceRunLog } from "../../lib/events";
import type { ProjectType, RunState } from "../../lib/types";

interface Props {
  workspaceId: string;
  /** Decides the preview surface: web → iframe, flutter → device status. */
  projectType: ProjectType | null;
}

/**
 * Run & preview panel: start/stop the project's run script in this workspace,
 * stream its output, and — for web projects — preview the discovered dev
 * server in an embedded iframe. State is pushed by the backend via
 * `workspace:run` / `workspace:run_log`; a snapshot seeds remounts.
 */
export function RunPanel({ workspaceId, projectType }: Props) {
  const [state, setState] = useState<RunState | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Bumped to force an iframe reload.
  const [frameNonce, setFrameNonce] = useState(0);
  const logRef = useRef<HTMLPreElement>(null);

  // Seed from the snapshot, then apply event deltas.
  useEffect(() => {
    let cancelled = false;
    setState(null);
    setLog([]);
    void fetchRunState(workspaceId).then((snap) => {
      if (cancelled) return;
      setState(snap.state);
      setLog(snap.log);
    });

    const unsubs: (() => void)[] = [];
    let dead = false;
    void onWorkspaceRun((p) => {
      if (p.workspaceId === workspaceId) setState(p);
    }).then((fn) => (dead ? fn() : unsubs.push(fn)));
    void onWorkspaceRunLog((p) => {
      if (p.workspaceId === workspaceId)
        setLog((prev) => [...prev.slice(-399), p.chunk]);
    }).then((fn) => (dead ? fn() : unsubs.push(fn)));
    return () => {
      cancelled = true;
      dead = true;
      unsubs.forEach((fn) => fn());
    };
  }, [workspaceId]);

  // Keep the log pinned to the bottom as output streams in.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const running = state?.status === "running";
  const port = running ? state.ports[0] : undefined;
  const previewUrl = port ? `http://localhost:${port}` : null;
  const showPreview = projectType === "web" && previewUrl;

  async function toggle() {
    setBusy(true);
    try {
      if (running) await runStop(workspaceId);
      else await runStart(workspaceId);
    } catch (e) {
      toast.error("Run failed", { description: String(e) });
    }
    setBusy(false);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header: status + controls */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            running ? "bg-emerald-500" : "bg-muted-foreground/40",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {running
            ? previewUrl
              ? previewUrl
              : "Running — waiting for a port…"
            : state
              ? `Exited${state.exitCode != null ? ` (${state.exitCode})` : ""}`
              : "Not running"}
        </span>
        {showPreview && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Reload preview"
              onClick={() => setFrameNonce((n) => n + 1)}
            >
              <RotateCw className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Open in browser"
              onClick={() =>
                openExternal(previewUrl).catch((e) => toast.error(String(e)))
              }
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </>
        )}
        <Button
          variant={running ? "outline" : "default"}
          size="sm"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() => void toggle()}
        >
          {running ? (
            <>
              <Square className="size-3" /> Stop
            </>
          ) : (
            <>
              <Play className="size-3" /> Run
            </>
          )}
        </Button>
      </div>

      {/* Preview (web) / device note (flutter) */}
      {showPreview ? (
        <iframe
          key={`${previewUrl}-${frameNonce}`}
          src={previewUrl}
          title="App preview"
          className="min-h-0 flex-1 border-0 bg-white"
        />
      ) : (
        running &&
        projectType === "flutter" && (
          <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            Running on a local device — check your emulator or simulator.
          </div>
        )
      )}

      {/* Output log */}
      <pre
        ref={logRef}
        className={cn(
          "m-0 select-text overflow-y-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground",
          showPreview
            ? "h-36 shrink-0 border-t border-border"
            : "min-h-0 flex-1",
        )}
      >
        {log.length
          ? log.join("\n")
          : "Output will appear here when the run script starts."}
      </pre>
    </div>
  );
}
