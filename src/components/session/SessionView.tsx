import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Columns2,
  Loader2,
  TriangleAlert
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useCancellableEffect } from "../../hooks/useCancellableEffect";
import { usePrPipeline } from "../../hooks/usePrPipeline";
import { useWorkspaceData } from "../../hooks/useWorkspaceData";
import { restartServer, setAutofixMode, startServer } from "../../lib/api";
import { OpencodeClient } from "../../lib/opencode";
import type {
  AutofixMode,
  ContextInfo,
  ProjectView,
  Workspace,
} from "../../lib/types";
import { workspaceLabel } from "../../lib/types";
import { ChangesView } from "../center/ChangesView";
import { FileView } from "../center/FileView";
import { Chat, type WorkspaceAction } from "../Chat";
import { CommitButton } from "../CommitButton";
import { ChangesPanel } from "../layout/ChangesPanel";
import { usePreferences } from "../PreferencesProvider";
import { PrPipeline } from "./PrPipeline";

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
export function SessionView({
  workspace,
  project,
  onRenamed,
  reloadNonce = 0,
  sidebarCollapsed = false,
}: Props) {
  const { prefs, setPref } = usePreferences();
  const { diffStats, prByWorkspace } = useWorkspaceData();
  const [state, setState] = useState<State>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);
  const [pendingAction, setPendingAction] = useState<WorkspaceAction | null>(
    null,
  );
  const [context, setContext] = useState<ContextInfo | null>(null);

  const isQuickChat = workspace.kind === "QuickChat";
  const isWorktree = workspace.kind === "Worktree";
  const baseUrl = state.kind === "ready" ? state.baseUrl : null;
  const changedCount = diffStats[workspace.id]?.files ?? 0;

  // PR pipeline state is pushed by the backend supervisor (which also runs the
  // autofix/superfix loop). This is a pure view over it.
  const pipeline = usePrPipeline(workspace.id, isWorktree && state.kind === "ready");
  // Autofix mode is backend-owned. The `workspace:pr` payload carries the
  // authoritative mode (persisted in the registry), so it survives workspace
  // switches; fall back to the registry snapshot on the workspace prop. Mirror
  // locally for instant control feedback.
  const backendMode = prByWorkspace[workspace.id]?.mode;
  const [autofixMode, setAutofixModeState] = useState<AutofixMode>(
    backendMode ?? workspace.autofix_mode ?? "off",
  );
  useEffect(() => {
    setAutofixModeState(backendMode ?? workspace.autofix_mode ?? "off");
  }, [workspace.id, backendMode, workspace.autofix_mode]);
  const changeAutofixMode = useCallback(
    (m: AutofixMode) => {
      setAutofixModeState(m);
      void setAutofixMode(workspace.id, m);
    },
    [workspace.id],
  );

  const changesOpen = prefs.changesPanelOpen;
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
  const markAllViewed = useCallback(
    (paths: string[]) => setViewed(new Set(paths)),
    [],
  );

  // ── Resizable changes panel (percentage of the session body, persisted
  //    globally in preferences so it's shared across all sessions) ──
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Gates the open/close transition: false until after the first paint so the
  // panel appears at its saved state instantly on mount / session switch, and
  // only animates on an explicit toggle thereafter.
  const [animate, setAnimate] = useState(false);
  const [changesPct, setChangesPct] = useState(() =>
    Math.min(70, Math.max(20, prefs.changesPanelWidthPct)),
  );
  const changesPctRef = useRef(changesPct);
  changesPctRef.current = changesPct;
  // Fixed pixel width for the panel + its content: derived from the % so the
  // content keeps its layout while the panel opens/closes (clip, not reflow).
  const changesPx = Math.round((changesPct / 100) * bodyWidth);

  // Measure synchronously before paint so the panel renders at its real width
  // on the very first frame (no 0 → measured jump that would animate on mount).
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setBodyWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) =>
      setBodyWidth(entry.contentRect.width),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Enable transitions only after the first painted frame.
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const body = bodyRef.current;
      if (!body) return;
      const rect = body.getBoundingClientRect();
      setDragging(true);
      document.body.style.cursor = "col-resize";
      const onMove = (ev: MouseEvent) => {
        const pct = Math.min(
          70,
          Math.max(20, ((rect.right - ev.clientX) / rect.width) * 100),
        );
        changesPctRef.current = pct;
        setChangesPct(pct);
      };
      const onUp = () => {
        setDragging(false);
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setPref("changesPanelWidthPct", Math.round(changesPctRef.current));
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [setPref],
  );

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
        setState(
          ok
            ? { kind: "ready", baseUrl: info.base_url }
            : { kind: "error", message: "server did not become healthy" },
        );
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

  const pct =
    context && context.max > 0
      ? Math.round((context.used / context.max) * 100)
      : null;

  return (
    <div className="flex h-full flex-col">
      {/* Session header */}
      <header
        data-tauri-drag-region
        className={cn(
          "flex h-11 shrink-0 items-center gap-2 border-b border-border px-4",
          sidebarCollapsed && "pl-[120px]",
        )}
      >
        <div
          data-tauri-drag-region
          className="flex min-w-0 flex-1 items-center gap-1.5 text-sm"
        >
          {project && (
            <span
              data-tauri-drag-region
              className="shrink-0 text-muted-foreground"
            >
              {project.name}
            </span>
          )}
          {project && (
            <span data-tauri-drag-region className="text-muted-foreground/40">
              /
            </span>
          )}
          <span
            data-tauri-drag-region
            className="min-w-0 truncate font-medium"
            title={workspaceLabel(workspace)}
          >
            {workspaceLabel(workspace)}
          </span>
          {pct !== null && (
            <HoverCard openDelay={150}>
              <HoverCardTrigger
                className={cn(
                  "ml-2 shrink-0 text-xs",
                  pct >= 80 ? "text-warning" : "text-muted-foreground",
                )}
              >
                {pct}% context
              </HoverCardTrigger>
              <HoverCardContent
                side="bottom"
                align="start"
                className="w-56 text-xs"
              >
                <div className="font-medium text-foreground">
                  Context window
                </div>
                <p className="mt-1 text-muted-foreground">
                  {context!.used.toLocaleString()} /{" "}
                  {context!.max.toLocaleString()} tokens
                </p>
              </HoverCardContent>
            </HoverCard>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isWorktree && project && state.kind === "ready" && (
            <CommitButton
              workspace={workspace}
              project={project}
              onAction={setPendingAction}
            />
          )}
          {!isQuickChat && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "relative",
                    changesOpen && "bg-accent text-accent-foreground",
                  )}
                  onClick={() => setPref("changesPanelOpen", !changesOpen)}
                >
                  <Columns2 className="size-4" />
                  {changedCount > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground">
                      {changedCount > 9 ? "*" : changedCount}
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Toggle changes</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      {/* Body: chat + sliding, resizable changes panel */}
      <div ref={bodyRef} className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {isWorktree && state.kind === "ready" && (
            <PrPipeline
              status={pipeline.status}
              phase={pipeline.phase}
              attempts={pipeline.attempts}
              mode={autofixMode}
              onModeChange={changeAutofixMode}
            />
          )}
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
              <p className="text-muted-foreground">
                Could not start the session.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAttempt((a) => a + 1)}
              >
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Starting session…
            </div>
          )}
        </div>

        {!isQuickChat && changesOpen && (
          <div
            onMouseDown={startResize}
            className={cn(
              "w-1 shrink-0 cursor-col-resize transition-colors",
              dragging ? "bg-primary/50" : "bg-border/60 hover:bg-primary/40",
            )}
          />
        )}
        {!isQuickChat && (
          <div
            style={{ width: changesOpen ? changesPx : 0 }}
            className={cn(
              "shrink-0 overflow-hidden",
              dragging || !animate
                ? "transition-none"
                : "transition-[width,opacity] duration-100 ease-out",
              changesOpen ? "opacity-100" : "opacity-0",
            )}
          >
            <div className="flex h-full flex-col" style={{ width: changesPx }}>
              {panelMode.kind === "list" ? (
                <ChangesPanel
                  workspace={workspace}
                  viewed={viewed}
                  onToggleViewed={toggleViewed}
                  onOpenFile={(path) =>
                    setPanelMode({ kind: "diff", file: path })
                  }
                  onViewFile={(path) =>
                    setPanelMode({ kind: "file", file: path })
                  }
                  baseUrl={baseUrl}
                  onRestart={restart}
                />
              ) : (
                <>
                  <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2 text-xs">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setPanelMode({ kind: "list" })}
                    >
                      <ArrowLeft className="size-3.5" />
                    </Button>
                    <span
                      className="min-w-0 flex-1 truncate font-mono"
                      title={panelMode.file ?? undefined}
                    >
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
                      <FileView
                        workspaceId={workspace.id}
                        file={panelMode.file}
                      />
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
