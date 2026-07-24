import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ArrowLeft, Columns2, Maximize2, Minimize2, Play } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useChat } from "../../hooks/useChat";
import { usePrPipeline } from "../../hooks/usePrPipeline";
import { useWorkspaceData } from "../../hooks/useWorkspaceData";
import { chatNewSession, setAutofixMode } from "../../lib/api";
import { displayText } from "../../lib/chatDisplay";
import {
  buildReviewMessage,
  type ChangeScope,
  type LastTurnInfo,
  type NewReviewComment,
  type ReviewComment,
} from "../../lib/review";
import type { AutofixMode, ProjectView, Workspace } from "../../lib/types";
import { workspaceLabel } from "../../lib/types";
import { ChangesView } from "../center/ChangesView";
import { FileView } from "../center/FileView";
import { Chat, type WorkspaceAction } from "../Chat";
import { CommitButton } from "../CommitButton";
import { ChangesPanel } from "../layout/ChangesPanel";
import { usePreferences } from "../PreferencesProvider";
import { PrPipeline } from "./PrPipeline";
import { RunPanel } from "./RunPanel";

interface Props {
  workspace: Workspace;
  project: ProjectView | null;
  onRenamed: (workspaceId: string, name: string) => void;
  /** When the sidebar is collapsed, pad the header to clear traffic lights. */
  sidebarCollapsed?: boolean;
  /** Open Settings → Models (from the model picker's "Manage models"). */
  onManageModels: () => void;
}

/** Right-panel content mode. */
type PanelMode =
  | { kind: "list" }
  | { kind: "diff"; file: string | null }
  | { kind: "file"; file: string };

/** Panel width bounds: the panel itself and the chat column beside it. */
const MIN_PANEL_PX = 320;
const MIN_CHAT_PX = 360;

/** True while any popup layer is open (dialog, dropdown, select, popover,
 *  context menu…) — those own the Esc key. Radix portals its poppers into
 *  `[data-radix-popper-content-wrapper]`; dialogs carry our shadcn data-slot. */
function hasOpenOverlay(): boolean {
  return !!document.querySelector(
    '[data-slot="dialog-content"][data-state="open"], [data-radix-popper-content-wrapper]',
  );
}

/**
 * A session = one workspace's chat (driven by the Rust ACP engine + SQLite
 * cache), with an on-demand git changes panel that slides in from the right.
 * Quick chats have no git, so the changes panel and commit actions are hidden.
 */
export function SessionView({
  workspace,
  project,
  onRenamed,
  sidebarCollapsed = false,
  onManageModels,
}: Props) {
  const { prefs, setPref } = usePreferences();
  const { diffStats, prByWorkspace } = useWorkspaceData();
  const [pendingAction, setPendingAction] = useState<WorkspaceAction | null>(
    null,
  );

  const isQuickChat = workspace.kind === "QuickChat";
  const isWorktree = workspace.kind === "Worktree";
  const changedCount = diffStats[workspace.id]?.files ?? 0;

  // Chat store lives here (not in <Chat>) so the changes panel can read turn
  // state ("Last turn" scoping) and send batched review comments.
  const chat = useChat(workspace.id);

  // PR pipeline state is pushed by the backend supervisor (which also runs the
  // autofix/superfix loop). This is a pure view over it.
  const pipeline = usePrPipeline(workspace.id, isWorktree);
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
  const [panelMax, setPanelMax] = useState(false);
  // Run & preview panel — shares the right-panel slot with changes.
  const [runOpen, setRunOpen] = useState(false);
  const hasRunScript = !!project?.run.run_script?.trim();
  const panelOpen = changesOpen || runOpen;
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

  // ── "Last turn" scope source: the newest assistant turn's edited files plus
  //    the user prompt that started it (the collapse summary is backend-computed
  //    and streams live, so this stays correct mid-turn). ──
  const lastTurn: LastTurnInfo | null = useMemo(() => {
    const es = chat.entries;
    for (let i = es.length - 1; i >= 0; i--) {
      const e = es[i];
      if (e.type !== "assistant") continue;
      let label: string | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const u = es[j];
        if (u.type === "user") {
          // Typed displays (e.g. review cards) project to a one-line label.
          label = displayText(u.display) || null;
          break;
        }
      }
      return { files: e.summary.filesEdited, label };
    }
    return null;
  }, [chat.entries]);

  // Changes-panel scope, shared between the file list and the diff view.
  // Reset to "Last turn" per workspace — reviewing the newest work is the
  // default posture after an AI turn.
  const [changeScope, setChangeScope] = useState<ChangeScope>("turn");
  useEffect(() => setChangeScope("turn"), [workspace.id]);

  // Bumps as the newest turn progresses (per completed step and on terminal
  // status), so per-file diffs re-fetch even when an edit leaves a file's
  // +/− counts unchanged (e.g. rewriting one line) and the diff-cache
  // signature alone wouldn't notice.
  const diffNonce = useMemo(() => {
    const es = chat.entries;
    for (let i = es.length - 1; i >= 0; i--) {
      const e = es[i];
      if (e.type === "assistant")
        return `${e.seq}:${e.status}:${e.summary.stepCount}`;
    }
    return "";
  }, [chat.entries]);

  // ── Pending review comments (per workspace, in-memory) ──
  const [comments, setComments] = useState<ReviewComment[]>([]);
  useEffect(() => setComments([]), [workspace.id]);

  const addComment = useCallback(
    (c: NewReviewComment) =>
      setComments((prev) => [...prev, { ...c, id: crypto.randomUUID() }]),
    [],
  );
  const removeComment = useCallback(
    (id: string) => setComments((prev) => prev.filter((c) => c.id !== id)),
    [],
  );
  const clearComments = useCallback(() => setComments([]), []);
  const sendComments = useCallback(() => {
    // Side effects must stay out of the setState updater — StrictMode invokes
    // updaters twice in dev, which double-sent the review message.
    if (comments.length === 0) return;
    const msg = buildReviewMessage(comments);
    void chat.send({ display: msg.display, sent: msg.sent, origin: "user" });
    setComments([]);
  }, [chat, comments]);

  // ── Resizable changes panel (fixed pixel width, persisted globally in
  //    preferences so it's shared across all sessions) ──
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Gates the open/close transition: false until after the first paint so the
  // panel appears at its saved state instantly on mount / session switch, and
  // only animates on an explicit toggle thereafter.
  const [animate, setAnimate] = useState(false);
  const [changesPx, setChangesPx] = useState(() =>
    Math.max(MIN_PANEL_PX, prefs.changesPanelWidthPx),
  );
  const changesPxRef = useRef(changesPx);
  changesPxRef.current = changesPx;
  // Keep the chat column usable when the window shrinks: cap the panel to the
  // body width minus the chat minimum (the saved width is restored on regrow).
  const effectivePx =
    bodyWidth > 0
      ? Math.min(changesPx, Math.max(MIN_PANEL_PX, bodyWidth - MIN_CHAT_PX))
      : changesPx;

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
        const px = Math.min(
          Math.max(MIN_PANEL_PX, rect.width - MIN_CHAT_PX),
          Math.max(MIN_PANEL_PX, rect.right - ev.clientX),
        );
        changesPxRef.current = px;
        setChangesPx(px);
      };
      const onUp = () => {
        setDragging(false);
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setPref("changesPanelWidthPx", Math.round(changesPxRef.current));
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [setPref],
  );

  // ── Focus mode: the panel maximizes over the whole session body ──
  useEffect(() => {
    if (!panelOpen) setPanelMax(false);
  }, [panelOpen]);

  // The run panel is per-workspace UI state; don't carry it across switches.
  useEffect(() => setRunOpen(false), [workspace.id]);

  // Esc peels back one layer at a time: popups first (dialogs, menus — they
  // handle Esc themselves, we stay out of the way), then focus mode, then the
  // panel itself. Typing contexts keep Esc for their own cancel semantics.
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      if (hasOpenOverlay()) return;
      if (panelMax) setPanelMax(false);
      else if (runOpen) setRunOpen(false);
      else setPref("changesPanelOpen", false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, panelMax, runOpen, setPref]);

  const maxToggle = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setPanelMax((v) => !v)}
        >
          {panelMax ? (
            <Minimize2 className="size-3.5" />
          ) : (
            <Maximize2 className="size-3.5" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {panelMax ? "Exit focus mode (Esc)" : "Focus mode"}
      </TooltipContent>
    </Tooltip>
  );

  // "Restart engine" from the tools panel: start a fresh ACP session (keeps all
  // prior transcript entries; picks up config changes).
  const restart = useCallback(() => {
    void chatNewSession(workspace.id, "cleared");
  }, [workspace.id]);

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
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isWorktree && project && (
            <CommitButton
              workspace={workspace}
              project={project}
              onAction={setPendingAction}
            />
          )}
          {!isQuickChat && hasRunScript && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(runOpen && "bg-accent text-accent-foreground")}
                  onClick={() => setRunOpen((v) => !v)}
                >
                  <Play className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Run & preview</TooltipContent>
            </Tooltip>
          )}
          {!isQuickChat && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "relative",
                    changesOpen &&
                      !runOpen &&
                      "bg-accent text-accent-foreground",
                  )}
                  onClick={() => {
                    setRunOpen(false);
                    setPref("changesPanelOpen", runOpen ? true : !changesOpen);
                  }}
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
      <div ref={bodyRef} className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {isWorktree && (
            <PrPipeline
              status={pipeline.status}
              phase={pipeline.phase}
              attempts={pipeline.attempts}
              mode={autofixMode}
              onModeChange={changeAutofixMode}
            />
          )}
          <Chat
            key={workspace.id}
            workspace={workspace}
            chat={chat}
            onRenamed={onRenamed}
            pendingAction={pendingAction}
            onActionConsumed={() => setPendingAction(null)}
            onManageModels={onManageModels}
          />
        </div>

        {!isQuickChat && panelOpen && !panelMax && (
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
            style={{ width: panelOpen ? effectivePx : 0 }}
            className={cn(
              "shrink-0 overflow-hidden",
              dragging || !animate
                ? "transition-none"
                : "transition-[width,opacity] duration-100 ease-out",
              panelOpen ? "opacity-100" : "opacity-0",
            )}
          >
            {/* In focus mode this escapes the width-clipped wrapper and covers
                the session body (same instance, so panel state survives). */}
            <div
              className={cn(
                "flex h-full flex-col",
                panelMax && "absolute inset-0 z-20 bg-background",
              )}
              style={panelMax ? undefined : { width: effectivePx }}
            >
              {runOpen ? (
                <RunPanel
                  workspaceId={workspace.id}
                  projectType={project?.run.project_type ?? null}
                  previewPath={project?.run.preview_path ?? null}
                />
              ) : panelMode.kind === "list" ? (
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
                  onRestart={restart}
                  actions={maxToggle}
                  lastTurn={lastTurn}
                  scope={changeScope}
                  onScopeChange={setChangeScope}
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
                    {panelMode.kind === "diff" ? (
                      <span className="min-w-0 flex-1 truncate font-medium">
                        Change details
                      </span>
                    ) : (
                      <span
                        className="min-w-0 flex-1 truncate font-mono"
                        title={panelMode.file}
                      >
                        {panelMode.file}
                      </span>
                    )}
                    {maxToggle}
                  </div>
                  <div className="min-h-0 flex-1">
                    {panelMode.kind === "diff" ? (
                      <ChangesView
                        workspaceId={workspace.id}
                        focusedFile={panelMode.file}
                        viewed={viewed}
                        onToggleViewed={toggleViewed}
                        onMarkAllViewed={markAllViewed}
                        lastTurn={lastTurn}
                        scope={changeScope}
                        onScopeChange={setChangeScope}
                        diffNonce={diffNonce}
                        comments={comments}
                        onAddComment={addComment}
                        onRemoveComment={removeComment}
                        onClearComments={clearComments}
                        onSendComments={sendComments}
                        busy={chat.busy}
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
