import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ExternalLink, Play, RotateCw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  androidPreview,
  androidState as fetchAndroidState,
  androidTap,
  openExternal,
  runStart,
  runState as fetchRunState,
  runStop,
} from "../../lib/api";
import {
  onAndroidFrame,
  onWorkspaceAndroid,
  onWorkspaceRun,
  onWorkspaceRunLog,
} from "../../lib/events";
import type { AndroidState, ProjectType, RunState } from "../../lib/types";

interface Props {
  workspaceId: string;
  /** Decides the preview surface: web → iframe, flutter → local device,
   *  flutter-redroid → in-app Android screen. */
  projectType: ProjectType | null;
  /** Initial preview path (project setting) — for redirecting homepages. */
  previewPath: string | null;
}

/** Resolve the address-bar value against the discovered port: full URLs pass
 *  through, anything else is a path on `localhost:<port>`. */
function resolvePreviewUrl(
  port: number | undefined,
  target: string,
): string | null {
  const t = target.trim();
  if (/^https?:\/\//.test(t)) return t;
  if (!port) return null;
  return `http://localhost:${port}${t.startsWith("/") ? t : `/${t}`}`;
}

const ANDROID_LABEL: Record<AndroidState["status"], string> = {
  starting: "Starting Android container…",
  booting: "Booting Android…",
  ready: "Android ready",
  stopped: "Android stopped",
  error: "Android error",
};

/**
 * Run & preview panel: start/stop the project's run script in this workspace,
 * stream its output, and preview the app — an iframe for web dev servers, a
 * tappable screencap stream for flutter-redroid. State is pushed by the
 * backend via `workspace:run*` / `workspace:android*`; snapshots seed
 * remounts.
 */
export function RunPanel({ workspaceId, projectType, previewPath }: Props) {
  const [state, setState] = useState<RunState | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [android, setAndroid] = useState<AndroidState | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped to force an iframe reload.
  const [frameNonce, setFrameNonce] = useState(0);
  // Address bar: `target` is committed (drives the iframe), `draft` is what's
  // being typed. Cross-origin iframes can't report in-page navigation back,
  // so the bar only navigates — it doesn't track clicks inside the preview.
  const [target, setTarget] = useState(previewPath ?? "/");
  const [draft, setDraft] = useState(previewPath ?? "/");
  const logRef = useRef<HTMLPreElement>(null);
  const isRedroid = projectType === "flutter-redroid";

  useEffect(() => {
    setTarget(previewPath ?? "/");
    setDraft(previewPath ?? "/");
  }, [workspaceId, previewPath]);

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

  // Android state + screencap stream (flutter-redroid only). The preview
  // refcount tells the backend to push frames while this panel is open.
  useEffect(() => {
    if (!isRedroid) return;
    let cancelled = false;
    setAndroid(null);
    setFrame(null);
    void fetchAndroidState(workspaceId).then((s) => {
      if (!cancelled) setAndroid(s);
    });
    void androidPreview(workspaceId, true);

    const unsubs: (() => void)[] = [];
    let dead = false;
    void onWorkspaceAndroid((p) => {
      if (p.workspaceId === workspaceId) setAndroid(p);
    }).then((fn) => (dead ? fn() : unsubs.push(fn)));
    void onAndroidFrame((p) => {
      if (p.workspaceId === workspaceId) setFrame(p.dataUrl);
    }).then((fn) => (dead ? fn() : unsubs.push(fn)));
    return () => {
      cancelled = true;
      dead = true;
      unsubs.forEach((fn) => fn());
      void androidPreview(workspaceId, false);
    };
  }, [workspaceId, isRedroid]);

  // Keep the log pinned to the bottom as output streams in.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const running = state?.status === "running";
  const port = running ? state.ports[0] : undefined;
  const previewUrl = running ? resolvePreviewUrl(port, target) : null;
  const showWebPreview = projectType === "web" && previewUrl;
  const showAndroidPreview = isRedroid && frame !== null;
  const androidBusy =
    android?.status === "starting" || android?.status === "booting";

  const statusText = isRedroid
    ? android
      ? (android.message ?? ANDROID_LABEL[android.status]) +
        (android.status === "ready" && android.serial
          ? ` · ${android.serial}`
          : "")
      : "Not running"
    : running
      ? (previewUrl ?? "Running — waiting for a port…")
      : state
        ? `Exited${state.exitCode != null ? ` (${state.exitCode})` : ""}`
        : "Not running";

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

  function tap(e: React.MouseEvent<HTMLImageElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    void androidTap(workspaceId, x, y).catch((err) => toast.error(String(err)));
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header: status + controls */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            running || android?.status === "ready"
              ? "bg-emerald-500"
              : androidBusy
                ? "animate-pulse bg-warning"
                : android?.status === "error"
                  ? "bg-destructive"
                  : "bg-muted-foreground/40",
          )}
        />
        {showWebPreview ? (
          // Address bar: Enter navigates. A path stays on the discovered
          // port; a full http(s) URL is used as-is.
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setTarget(draft.trim() || "/");
                setFrameNonce((n) => n + 1);
              } else if (e.key === "Escape") {
                setDraft(target);
              }
            }}
            spellCheck={false}
            placeholder="/path or http://…"
            title={previewUrl ?? undefined}
            className="h-6 min-w-0 flex-1 rounded border border-input bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-ring"
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            title={statusText}
          >
            {statusText}
          </span>
        )}
        {showWebPreview && (
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
          disabled={busy || androidBusy}
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

      {/* Preview: web iframe / android screen / flutter device note */}
      {showWebPreview ? (
        <iframe
          key={`${previewUrl}-${frameNonce}`}
          src={previewUrl}
          title="App preview"
          className="min-h-0 flex-1 border-0 bg-white"
        />
      ) : showAndroidPreview ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/90 p-2">
          {/* Screencap stream; clicks are forwarded as taps. */}
          <img
            src={frame}
            alt="Android screen"
            onClick={tap}
            className="max-h-full max-w-full cursor-pointer rounded-md object-contain"
          />
        </div>
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
          showWebPreview || showAndroidPreview
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
