import { AccountAvatar } from "@/components/github/AccountAvatar";
import { useAppUpdate } from "@/hooks/useUpdateChecker";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useGitHub } from "@/hooks/useGitHub";
import { cn } from "@/lib/utils";
import {
  BotMessageSquare,
  ArrowUp,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleX,
  Cloud,
  Code2,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  House,
  Link2,
  ListFilter,
  ListTodo,
  Loader2,
  MessageCircleQuestion,
  MessagesSquare,
  MoreVertical,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings,
  Terminal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";
import { useWorkspaceData } from "../../hooks/useWorkspaceData";
import { openExternal, removeProject, removeWorkspace } from "../../lib/api";
import { onWorkspaceSetup } from "../../lib/events";
import { offerMarkTaskDone } from "../../lib/taskDone";
import {
  workspaceLabel,
  type PipelinePhase,
  type ProjectView,
  type PrStatus,
  type SessionPayload,
  type SetupState,
  type Workspace,
} from "../../lib/types";
import { usePreferences } from "../PreferencesProvider";

export type NavView = "home" | "my-work" | "automations" | "search";

interface NavItemDef {
  id: NavView;
  label: string;
  icon: typeof House;
  enabled: boolean;
}

const NAV: NavItemDef[] = [
  { id: "home", label: "Home", icon: House, enabled: true },
  { id: "my-work", label: "My work", icon: ListTodo, enabled: true },
  {
    id: "automations",
    label: "Automations",
    icon: CalendarClock,
    enabled: false,
  },
  { id: "search", label: "Search", icon: Search, enabled: true },
];

interface Props {
  view: NavView | "session";
  onNavigate: (v: NavView) => void;
  /** Browser-style history (the chevrons; ⌘[ / ⌘] do the same). */
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onToggleCollapse: () => void;
  onOpenSettings: () => void;
  /** Open Settings on the Accounts tab (from the identity indicator). */
  onOpenAccounts: () => void;
  projects: ProjectView[];
  quickChats: Workspace[];
  /** Highlighted only while the session view is active. */
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (w: Workspace) => void;
  onProjectsChanged: () => void;
  onRenamed: (workspaceId: string, name: string) => void;
  onQuickCreate: (project: ProjectView) => void;
  onNewFromBranch: (project: ProjectView) => void;
  onNewFromPr: (project: ProjectView) => void;
  onNewQuickChat: () => void;
  onRemoveQuickChat: (id: string) => void;
  onAddProject: () => void;
  onOpenProjectSettings: (project: ProjectView) => void;
}

/**
 * The single left sidebar: top-level navigation, the Sessions tree
 * (quick chats + projects → workspaces), and a bottom account/settings bar.
 */
export function SessionsSidebar({
  view,
  onNavigate,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onToggleCollapse,
  onOpenSettings,
  onOpenAccounts,
  projects,
  quickChats,
  selectedWorkspaceId,
  onSelectWorkspace,
  onProjectsChanged,
  onRenamed,
  onQuickCreate,
  onNewFromBranch,
  onNewFromPr,
  onNewQuickChat,
  onRemoveQuickChat,
  onAddProject,
  onOpenProjectSettings,
}: Props) {
  const { prefs, setPref } = usePreferences();
  const updateAvailable = useAppUpdate().availableVersion !== null;
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Workspaces whose removeWorkspace call is in flight (teardown can take ~30s).
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  // Live setup-state overlay over the registry data (cleared on success).
  const [setupOverlay, setSetupOverlay] = useState<Map<string, SetupState>>(
    new Map(),
  );
  useEffect(() => {
    const unlisten = onWorkspaceSetup((p) => {
      setSetupOverlay((prev) => {
        // Keep terminal states in the overlay instead of deleting: the row's
        // registry snapshot (`w.setup`) is stale until the next projects
        // refresh, so falling back to it would leave the spinner on forever.
        const next = new Map(prev);
        if (p.ok) next.set(p.workspaceId, "ready");
        else next.set(p.workspaceId, p.running ? "provisioning" : "failed");
        return next;
      });
    });
    return () => void unlisten.then((f) => f());
  }, []);
  const [filter, setFilter] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () =>
      new Set(
        Object.entries(prefs.collapsedProjects)
          .filter(([, v]) => v)
          .map(([k]) => k),
      ),
  );

  const toggleCollapsed = (id: string) => {
    // Compute outside the state updater — calling setPref (another component's
    // state) from inside it is a React setState-in-render violation.
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const record: Record<string, boolean> = { ...prefs.collapsedProjects };
    if (next.has(id)) record[id] = true;
    else delete record[id];
    setCollapsed(next);
    setPref("collapsedProjects", record);
  };

  function setDeleting(id: string, on: boolean) {
    setDeletingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function deleteWorkspace(w: Workspace) {
    setDeleting(w.id, true);
    try {
      const unlinked = await removeWorkspace(w.id, false);
      onProjectsChanged();
      toast.success(`Deleted workspace ${workspaceLabel(w)}`);
      offerMarkTaskDone(unlinked);
    } catch (e) {
      const uncommitted = String(e).includes("uncommitted changes");
      toast.error(
        uncommitted
          ? "Workspace has uncommitted changes"
          : "Could not delete workspace",
        {
          description: uncommitted
            ? "Deleting it will discard them."
            : String(e),
          action: {
            label: "Delete anyway",
            onClick: () => {
              setDeleting(w.id, true);
              void removeWorkspace(w.id, true)
                .then((unlinked) => {
                  onProjectsChanged();
                  offerMarkTaskDone(unlinked);
                })
                .catch((e2) =>
                  toast.error("Could not delete workspace", {
                    description: String(e2),
                  }),
                )
                .finally(() => setDeleting(w.id, false));
            },
          },
        },
      );
    } finally {
      setDeleting(w.id, false);
    }
  }

  function startRename(w: Workspace) {
    setRenameValue(workspaceLabel(w));
    setRenaming(w);
  }

  function saveRename() {
    const name = renameValue.trim();
    if (renaming && name) onRenamed(renaming.id, name);
    setRenaming(null);
  }

  function openIn(w: Workspace, app?: string) {
    openExternal(w.path, app).catch((e) =>
      toast.error("Could not open", { description: String(e) }),
    );
  }

  const q = filter.trim().toLowerCase();
  const matches = (w: Workspace) =>
    !q || workspaceLabel(w).toLowerCase().includes(q);
  const shownQuickChats = quickChats.filter(matches);

  return (
    <aside className="flex h-full w-[264px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* Top strip: clears the macOS traffic lights, holds window/panel controls. */}
      <div
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center justify-end gap-0.5 pr-2 pl-20"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={onToggleCollapse}
            >
              <PanelLeft className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle sidebar ⌘B</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={canGoBack ? "text-muted-foreground" : "text-muted-foreground/50"}
              disabled={!canGoBack}
              onClick={onBack}
            >
              <ChevronLeft className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Back ⌘[</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={canGoForward ? "text-muted-foreground" : "text-muted-foreground/50"}
              disabled={!canGoForward}
              onClick={onForward}
            >
              <ChevronRight className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Forward ⌘]</TooltipContent>
        </Tooltip>
      </div>

      {/* Primary navigation */}
      <nav className="flex flex-col gap-0.5 px-2 pb-2">
        {NAV.map((item) => (
          <NavRow
            key={item.id}
            item={item}
            active={view === item.id}
            onClick={() => item.enabled && onNavigate(item.id)}
          />
        ))}
      </nav>

      {/* Sessions */}
      <div className="flex items-center gap-1 px-3 pb-1 pt-4">
        <span className="flex-1 text-[12px] pl-1 font-medium text-muted-foreground">
          Sessions
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(filterOpen && "text-foreground")}
              onClick={() => {
                setFilterOpen((o) => !o);
                if (filterOpen) setFilter("");
              }}
            >
              <ListFilter className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Filter sessions</TooltipContent>
        </Tooltip>
        <NewSessionMenu
          projects={projects}
          onStartInProject={onQuickCreate}
          onNewQuickChat={onNewQuickChat}
          onAddProject={onAddProject}
        />
      </div>

      {filterOpen && (
        <div className="px-2 pb-1">
          <Input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="h-7 text-xs"
          />
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-1 pb-2">
          {/* Quick chats — same collapsible group as the projects. */}
          <SidebarGroup
            icon={<BotMessageSquare className="size-4" />}
            label="Quick chats"
            collapsed={collapsed.has(QUICK_CHATS_ID) && !q}
            onToggle={() => toggleCollapsed(QUICK_CHATS_ID)}
            actions={
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onNewQuickChat}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New quick chat</TooltipContent>
              </Tooltip>
            }
          >
            {shownQuickChats.length === 0
              ? !q && (
                  <button
                    onClick={onNewQuickChat}
                    className="block px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
                  >
                    Start a context-free chat…
                  </button>
                )
              : shownQuickChats.map((w) => (
                  <WorkspaceRow
                    key={w.id}
                    workspace={w}
                    selected={w.id === selectedWorkspaceId}
                    deleting={deletingIds.has(w.id)}
                    setup={setupOverlay.get(w.id) ?? w.setup}
                    onSelect={() => onSelectWorkspace(w)}
                    onDelete={() => onRemoveQuickChat(w.id)}
                    onRename={() => startRename(w)}
                    terminalApp={prefs.terminalApp}
                    editorApp={prefs.editorApp}
                    onOpenIn={openIn}
                  />
                ))}
          </SidebarGroup>

          {projects.length === 0 && (
            <EmptyState dense className="px-3 py-4 text-xs">
              No projects yet. Add a repository from the + menu.
            </EmptyState>
          )}

          {/* Projects → workspaces */}
          {projects.map((p) => {
            const shown = p.workspaces.filter(matches);
            if (q && shown.length === 0) return null;
            return (
              <SidebarGroup
                key={p.id}
                icon={<Folder className="size-4" />}
                label={p.name}
                collapsed={collapsed.has(p.id) && !q}
                onToggle={() => toggleCollapsed(p.id)}
                actions={
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => onQuickCreate(p)}
                        >
                          <Plus className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>New session in {p.name}</TooltipContent>
                    </Tooltip>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm">
                          <MoreVertical className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <Plus className="size-4" /> New session
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            <DropdownMenuItem onClick={() => onQuickCreate(p)}>
                              <GitBranch className="size-4" /> From base branch
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => onNewFromBranch(p)}
                            >
                              <GitBranch className="size-4" /> From branch…
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => onNewFromPr(p)}>
                              <GitPullRequest className="size-4" /> From pull
                              request…
                            </DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuItem
                          onClick={() => onOpenProjectSettings(p)}
                        >
                          <Settings className="size-4" /> Project settings
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() =>
                            void removeProject(p.id).then(onProjectsChanged)
                          }
                        >
                          <Trash2 className="size-4" /> Remove project
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                }
              >
                {shown.length === 0 && !q ? (
                  <span className="px-2 py-1 text-xs text-muted-foreground">
                    No sessions yet
                  </span>
                ) : (
                  shown.map((w) => (
                    <WorkspaceRow
                      key={w.id}
                      workspace={w}
                      selected={w.id === selectedWorkspaceId}
                      deleting={deletingIds.has(w.id)}
                      setup={setupOverlay.get(w.id) ?? w.setup}
                      onSelect={() => onSelectWorkspace(w)}
                      onDelete={() => void deleteWorkspace(w)}
                      onRename={() => startRename(w)}
                      terminalApp={prefs.terminalApp}
                      editorApp={prefs.editorApp}
                      onOpenIn={openIn}
                    />
                  ))
                )}
              </SidebarGroup>
            );
          })}
        </div>
      </ScrollArea>

      {/* Bottom account / settings bar */}
      <div className="flex items-center gap-2 p-2">
        <AccountIndicator onOpenAccounts={onOpenAccounts} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative text-muted-foreground"
              onClick={onOpenSettings}
            >
              <Settings className="size-4" />
              {updateAvailable && (
                <span
                  aria-label="Update available"
                  className="absolute -right-0.5 -top-0.5 flex size-3 items-center justify-center rounded-full bg-info text-background"
                >
                  <ArrowUp className="size-2.5" strokeWidth={3} />
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {updateAvailable ? "Update available · Settings ⌘," : "Settings ⌘,"}
          </TooltipContent>
        </Tooltip>
      </div>

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="w-full max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveRename()}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button onClick={saveRename} disabled={!renameValue.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function NavRow({
  item,
  active,
  onClick,
}: {
  item: NavItemDef;
  active: boolean;
  onClick: () => void;
}) {
  const row = (
    <button
      onClick={onClick}
      disabled={!item.enabled}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
        !item.enabled &&
          "opacity-40 hover:bg-transparent hover:text-muted-foreground",
      )}
    >
      <item.icon className="size-4 shrink-0" />
      {item.label}
    </button>
  );
  if (item.enabled) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="right">Coming soon</TooltipContent>
    </Tooltip>
  );
}

/** Collapse-state key for the Quick chats group (lives in the same persisted
 *  `collapsedProjects` record as project ids). */
const QUICK_CHATS_ID = "quick-chats";

/**
 * One collapsible sidebar group: a header row (16px icon slot that swaps to a
 * chevron on hover, hover-only actions) and children hanging off a vertical
 * guide line indented to the start of the header text. Shared by Quick chats
 * and the projects so the treatments can't drift apart.
 */
function SidebarGroup({
  icon,
  label,
  collapsed,
  onToggle,
  actions,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      {/* Same pill geometry as the top NavRows (8px inset each side,
          px-2.5 py-1.5) so project rows and nav rows read as one family;
          the icon column and text column stay aligned with the nav. */}
      <div className="group/project mx-1 flex h-8 min-w-0 items-center rounded-md px-2.5 hover:bg-sidebar-accent/60">
        {/* gap-2.5 matches the top nav rows so header text sits in the same
            column as "Home" / "Search". */}
        <button
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          onClick={onToggle}
        >
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            {collapsed ? (
              // A collapsed group always shows the chevron — its state should
              // be visible without hovering.
              <ChevronRight className="size-4" />
            ) : (
              <>
                <span className="group-hover/project:hidden">{icon}</span>
                <ChevronDown className="hidden size-4 group-hover/project:block" />
              </>
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm" title={label}>
            {label}
          </span>
        </button>
        <span className="flex shrink-0 items-center text-muted-foreground opacity-0 focus-within:opacity-100 group-hover/project:opacity-100">
          {actions}
        </span>
      </div>
      {/* Children: guide line under the header icon's center; the children's
          icon column starts exactly where the header text starts. */}
      {!collapsed && (
        <div className="ml-[22px] flex flex-col border-l border-sidebar-border pl-[9px]">
          {children}
        </div>
      )}
    </div>
  );
}

/** The row-1 AI status icon + row-2 activity label, from pushed state. */
function aiState(
  session: SessionPayload | undefined,
  phase: PipelinePhase | undefined,
): { icon: React.ReactNode; label?: string; labelClass?: string } {
  const working = session?.activity === "working";
  if (working) {
    return {
      icon: (
        <Loader2
          className="size-3.5 shrink-0 animate-spin text-primary"
          aria-label="Working"
        />
      ),
      label: phase === "fixing" ? "Fixing CI…" : "Working…",
      labelClass: "text-primary",
    };
  }
  if (session?.awaitingInput) {
    return {
      icon: (
        <MessageCircleQuestion
          className="size-3.5 shrink-0 text-warning"
          aria-label="Waiting for you"
        />
      ),
      label: "Waiting for you",
      labelClass: "text-warning",
    };
  }
  if (session?.needsAttention) {
    return {
      icon: (
        <span
          className="size-[7px] shrink-0 rounded-full bg-primary"
          aria-label="Finished — unseen"
        />
      ),
      label: "Ready for review",
      labelClass: "text-warning",
    };
  }
  if (phase === "exhausted") {
    return {
      icon: (
        <TriangleAlert
          className="size-3.5 shrink-0 text-warning"
          aria-label="Autofix paused"
        />
      ),
      label: "Autofix paused",
      labelClass: "text-muted-foreground",
    };
  }
  if (session?.error) {
    return {
      icon: (
        <CircleX
          className="size-3.5 shrink-0 text-destructive"
          aria-label="Last turn failed"
        />
      ),
      label: "Last turn failed",
      labelClass: "text-destructive",
    };
  }
  return {
    icon: <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />,
  };
}

/** Compact PR chip: state icon (color = open/merged/closed) + number + CI dot.
 *  Failing adds a `n/total` count; merged/closed say it with the icon alone. */
function PrChip({ pr }: { pr: PrStatus }) {
  const failing = pr.checks.filter((c) => c.bucket === "failure").length;
  const counted = pr.checks.filter((c) => c.bucket !== "skipped").length;
  const Icon =
    pr.state === "MERGED"
      ? GitMerge
      : pr.state === "CLOSED"
        ? GitPullRequestClosed
        : GitPullRequest;
  const iconClass =
    pr.state === "MERGED"
      ? "text-[#a371f7]"
      : pr.state === "CLOSED"
        ? "text-destructive"
        : "text-additions";
  const title =
    pr.state === "OPEN"
      ? failing > 0
        ? `PR #${pr.number} — ${failing} of ${counted} checks failing`
        : `PR #${pr.number} — checks ${pr.rollup === "success" ? "passing" : pr.rollup === "pending" ? "running" : "none"}`
      : `PR #${pr.number} — ${pr.state.toLowerCase()}`;
  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.06] py-px pl-1 pr-1.5 font-mono text-[10px] leading-4"
      title={title}
    >
      <Icon className={cn("size-[11px] shrink-0", iconClass)} />#{pr.number}
      {pr.state === "OPEN" && pr.rollup === "success" && (
        <span className="size-[7px] rounded-full bg-additions" />
      )}
      {pr.state === "OPEN" && pr.rollup === "pending" && (
        <span className="size-[7px] animate-pulse rounded-full bg-warning" />
      )}
      {pr.state === "OPEN" && pr.rollup === "failure" && (
        <>
          <span className="size-[7px] rounded-full bg-destructive" />
          <span className="text-destructive">
            {failing}/{counted}
          </span>
        </>
      )}
    </span>
  );
}

function WorkspaceRow({
  workspace: w,
  selected,
  deleting,
  setup,
  onSelect,
  onDelete,
  onRename,
  terminalApp,
  editorApp,
  onOpenIn,
}: {
  workspace: Workspace;
  selected: boolean;
  /** removeWorkspace in flight (teardown can take ~30s). */
  deleting: boolean;
  /** Registry setup state, overlaid with live `workspace:setup` events. */
  setup: SetupState;
  onSelect: () => void;
  onDelete: () => void;
  onRename: () => void;
  terminalApp?: string;
  editorApp?: string;
  onOpenIn?: (w: Workspace, app?: string) => void;
}) {
  const {
    diffStats: stats,
    sessionByWorkspace,
    prByWorkspace,
    branchByWorkspace,
  } = useWorkspaceData();
  const stat = stats[w.id];
  const session = sessionByWorkspace[w.id];
  const prPayload = prByWorkspace[w.id];
  const pr = prPayload?.status ?? null;
  const isQuickChat = w.kind === "QuickChat";

  const ai = aiState(session, prPayload?.phase);
  // Deleting / provisioning / failed-setup take over the status icon slot.
  const statusIcon =
    deleting || setup === "provisioning" ? (
      <Loader2
        className="size-3.5 shrink-0 animate-spin text-muted-foreground"
        aria-label={deleting ? "Deleting…" : "Setting up…"}
      />
    ) : setup === "failed" ? (
      <TriangleAlert
        className="size-3.5 shrink-0 text-destructive"
        aria-label="Setup failed"
      />
    ) : (
      ai.icon
    );
  // Row 1 is identity: the live checked-out branch (the agent may rename it),
  // else the registry branch, else the label for quick chats.
  const primary = branchByWorkspace[w.id] ?? w.branch ?? workspaceLabel(w);
  // Row 2 is status: PR chip + AI activity + the AI-generated name (secondary).
  // Quiet rows (nothing to say) stay single-line. With both a PR chip and an
  // active AI label there's no useful room left — the name yields until the
  // row goes quiet (it stays available as the row tooltip).
  const secondaryName =
    !isQuickChat && w.name && !(pr && ai.label) ? w.name : null;
  const hasRow2 = Boolean(pr || ai.label || secondaryName);

  // One shared item list drives both the right-click context menu and the ⋮
  // dropdown so the two can't drift apart. A separator renders before Rename.
  const menuItems: {
    icon: typeof Terminal;
    label: string;
    onClick: () => void;
    destructive?: boolean;
  }[] = [
    {
      icon: Terminal,
      label: "Open in terminal",
      onClick: () => onOpenIn?.(w, terminalApp),
    },
    { icon: FolderOpen, label: "Open in Finder", onClick: () => onOpenIn?.(w) },
    {
      icon: Code2,
      label: "Open in IDE",
      onClick: () => onOpenIn?.(w, editorApp),
    },
    { icon: Pencil, label: "Rename", onClick: onRename },
    {
      icon: Trash2,
      label: isQuickChat
        ? "Delete quick chat"
        : w.kind === "Base"
          ? "Delete base workspace"
          : "Delete session",
      onClick: onDelete,
      destructive: true,
    },
  ];
  const SEPARATOR_BEFORE = "Rename";

  const row = (
    <div
      className={cn(
        "group/ws relative min-w-0 rounded-md hover:bg-sidebar-accent/60",
        selected && "bg-sidebar-accent hover:bg-sidebar-accent",
        deleting && "pointer-events-none opacity-60",
      )}
    >
      <button
        className="flex w-full min-w-0 flex-col gap-0.5 px-2 py-1.5 text-left"
        onClick={onSelect}
      >
        {/* On hover, row 1 yields space to the (absolute) ⋮ so the diff slides
            left instead of being overlapped — the mock's slide-in. */}
        <span className="flex min-w-0 items-center gap-1.5 transition-[padding] duration-150 group-focus-within/ws:pr-6 group-hover/ws:pr-6 motion-reduce:transition-none">
          <span
            className="flex size-4 shrink-0 items-center justify-center"
            title={setup === "failed" ? "Setup failed" : undefined}
          >
            {statusIcon}
          </span>
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs tracking-tight text-sidebar-accent-foreground"
            title={!isQuickChat && w.name ? `${primary} — ${w.name}` : primary}
          >
            {primary}
          </span>
          {stat?.files ? (
            <span className="shrink-0 font-mono text-[10px] tabular-nums">
              <span className="text-additions">+{stat.insertions}</span>{" "}
              <span className="text-deletions">−{stat.deletions}</span>
            </span>
          ) : null}
        </span>
        {hasRow2 && (
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden pl-[22px]">
            {pr && <PrChip pr={pr} />}
            {ai.label && (
              <span
                className={cn(
                  "shrink-0 text-[10.5px] font-medium",
                  ai.labelClass,
                )}
              >
                {ai.label}
              </span>
            )}
            {secondaryName && (
              <span
                className="min-w-0 truncate text-[11px] text-muted-foreground"
                title={secondaryName}
              >
                {secondaryName}
              </span>
            )}
          </span>
        )}
      </button>
      {/* Hover-only overflow menu (also available via right-click): rename,
          open-in, delete — no instantly-destructive X on the row. Absolutely
          positioned on row 1 so it never inflates the row height (keeps
          single-line rows vertically aligned). */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute right-1 top-0.5 size-6 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover/ws:opacity-100 data-[state=open]:opacity-100"
            aria-label="Session actions"
          >
            <MoreVertical className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {menuItems.map((m) => (
            <Fragment key={m.label}>
              {m.label === SEPARATOR_BEFORE && <DropdownMenuSeparator />}
              <DropdownMenuItem
                variant={m.destructive ? "destructive" : undefined}
                onClick={m.onClick}
              >
                <m.icon className="size-4" /> {m.label}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        {menuItems.map((m) => (
          <Fragment key={m.label}>
            {m.label === SEPARATOR_BEFORE && <ContextMenuSeparator />}
            <ContextMenuItem
              variant={m.destructive ? "destructive" : undefined}
              onClick={m.onClick}
            >
              <m.icon className="size-4" /> {m.label}
            </ContextMenuItem>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function NewSessionMenu({
  projects,
  onStartInProject,
  onNewQuickChat,
  onAddProject,
}: {
  projects: ProjectView[];
  onStartInProject: (p: ProjectView) => void;
  onNewQuickChat: () => void;
  onAddProject: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm">
          <Plus className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[240px]">
        {projects.length > 0 && (
          <>
            <DropdownMenuLabel>Start session in</DropdownMenuLabel>
            {projects.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => onStartInProject(p)}>
                <Folder className="size-4" />
                <span className="truncate">{p.name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>Add project from</DropdownMenuLabel>
        <DropdownMenuItem onClick={onAddProject}>
          <FolderPlus className="size-4" /> Local folder or repository…
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <Cloud className="size-4" /> GitHub repository…
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <Link2 className="size-4" /> Repository URL…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Chat</DropdownMenuLabel>
        <DropdownMenuItem onClick={onNewQuickChat}>
          <MessagesSquare className="size-4" /> Quick chat
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The bottom-bar GitHub identity indicator. Zero accounts → a "Sign in" prompt;
 * one → avatar + login; several → a stacked avatar with a dropdown to switch
 * focus / manage. All routes open Settings → Accounts.
 */
function AccountIndicator({ onOpenAccounts }: { onOpenAccounts: () => void }) {
  const { accounts } = useGitHub();

  if (accounts.length === 0) {
    return (
      <button
        onClick={onOpenAccounts}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:text-sidebar-foreground"
      >
        <img
          src="/app-icon.png"
          alt="BranchLab"
          className="size-6 shrink-0 rounded-full border border-sidebar-border"
        />
        <span className="min-w-0 flex-1 truncate">Sign in to GitHub</span>
      </button>
    );
  }

  if (accounts.length === 1) {
    const a = accounts[0];
    return (
      <button
        onClick={onOpenAccounts}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-sidebar-accent/60"
      >
        <AccountAvatar account={a} className="size-6" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {a.login}
        </span>
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-sidebar-accent/60">
          <AccountAvatar account={accounts[0]} className="size-6" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {accounts.length} accounts
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuLabel>GitHub accounts</DropdownMenuLabel>
        {accounts.map((a) => (
          <DropdownMenuItem key={a.id} onClick={onOpenAccounts}>
            <AccountAvatar account={a} className="size-4" />
            <span className="min-w-0 flex-1 truncate">@{a.login}</span>
            <span className="text-xs text-muted-foreground">{a.host}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onOpenAccounts}>
          Manage accounts…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
