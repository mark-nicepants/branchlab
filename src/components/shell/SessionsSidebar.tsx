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
import { cn } from "@/lib/utils";
import {
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Code2,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  House,
  Link2,
  ListFilter,
  ListTodo,
  Loader2,
  MessagesSquare,
  MonitorSmartphone,
  MoreVertical,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useWorkspaceData } from "../../hooks/useWorkspaceData";
import { openExternal, removeProject, removeWorkspace } from "../../lib/api";
import {
  workspaceLabel,
  type ProjectView,
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
  { id: "my-work", label: "My work", icon: ListTodo, enabled: false },
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
  onToggleCollapse: () => void;
  onOpenSettings: () => void;
  projects: ProjectView[];
  quickChats: Workspace[];
  /** Highlighted only while the session view is active. */
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (w: Workspace) => void;
  onProjectsChanged: () => void;
  onRenamed: (workspaceId: string, name: string) => void;
  onQuickCreate: (project: ProjectView) => void;
  onNewFromBranch: (project: ProjectView) => void;
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
  onToggleCollapse,
  onOpenSettings,
  projects,
  quickChats,
  selectedWorkspaceId,
  onSelectWorkspace,
  onProjectsChanged,
  onRenamed,
  onQuickCreate,
  onNewFromBranch,
  onNewQuickChat,
  onRemoveQuickChat,
  onAddProject,
  onOpenProjectSettings,
}: Props) {
  const { prefs, setPref } = usePreferences();
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [renameValue, setRenameValue] = useState("");
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

  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const record: Record<string, boolean> = { ...prefs.collapsedProjects };
      if (next.has(id)) record[id] = true;
      else delete record[id];
      setPref("collapsedProjects", record);
      return next;
    });

  async function deleteWorkspace(w: Workspace) {
    try {
      await removeWorkspace(w.id, false);
      onProjectsChanged();
      toast.success(`Deleted workspace ${workspaceLabel(w)}`);
    } catch (e) {
      toast.error("Workspace has uncommitted changes", {
        description: String(e),
        action: {
          label: "Delete anyway",
          onClick: () =>
            void removeWorkspace(w.id, true)
              .then(onProjectsChanged)
              .catch((e2) => toast.error(String(e2))),
        },
      });
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
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground/50"
          disabled
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground/50"
          disabled
        >
          <ChevronRight className="size-4" />
        </Button>
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
      <div className="flex items-center gap-1 px-3 pb-1 pt-1">
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
          {/* Quick chats */}
          <GroupHeader
            icon={
              <MessagesSquare className="size-3.5 shrink-0 text-muted-foreground" />
            }
            label="Quick chats"
            onAdd={onNewQuickChat}
            addHint="New quick chat"
          />
          {shownQuickChats.length === 0
            ? !q && (
                <button
                  onClick={onNewQuickChat}
                  className="mb-2 ml-6 block px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
                >
                  Start a context-free chat…
                </button>
              )
            : shownQuickChats.map((w) => (
                <WorkspaceRow
                  key={w.id}
                  workspace={w}
                  selected={w.id === selectedWorkspaceId}
                  onSelect={() => onSelectWorkspace(w)}
                  onDelete={() => onRemoveQuickChat(w.id)}
                  onRename={() => startRename(w)}
                />
              ))}

          {projects.length === 0 && (
            <EmptyState dense className="px-3 py-4 text-xs">
              No projects yet. Add a repository from the + menu.
            </EmptyState>
          )}

          {/* Projects → workspaces */}
          {projects.map((p) => {
            const shown = p.workspaces.filter(matches);
            if (q && shown.length === 0) return null;
            const isCollapsed = collapsed.has(p.id) && !q;
            return (
              <div key={p.id} className="mb-2">
                <div className="group/project flex min-w-0 items-center px-2 py-1">
                  <button
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    onClick={() => toggleCollapsed(p.id)}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    <span
                      className="min-w-0 flex-1 truncate text-[13px] font-medium"
                      title={p.name}
                    >
                      {p.name}
                    </span>
                  </button>
                  <span className="flex shrink-0 items-center text-muted-foreground">
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
                            <DropdownMenuItem disabled>
                              <GitPullRequest className="size-4" /> From pull
                              request
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
                  </span>
                </div>

                {!isCollapsed &&
                  shown.map((w) => (
                    <WorkspaceRow
                      key={w.id}
                      workspace={w}
                      selected={w.id === selectedWorkspaceId}
                      onSelect={() => onSelectWorkspace(w)}
                      onDelete={() => void deleteWorkspace(w)}
                      onRename={() => startRename(w)}
                      terminalApp={prefs.terminalApp}
                      editorApp={prefs.editorApp}
                      onOpenIn={openIn}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Bottom account / settings bar */}
      <div className="flex items-center gap-2 border-t border-sidebar-border p-2">
        <img
          src="/app-icon.png"
          alt="BranchLab"
          className="size-6 shrink-0 rounded-full border border-sidebar-border"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          BranchLab
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={onOpenSettings}
            >
              <Settings className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings ⌘,</TooltipContent>
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

function GroupHeader({
  icon,
  label,
  onAdd,
  addHint,
}: {
  icon: React.ReactNode;
  label: string;
  onAdd: () => void;
  addHint: string;
}) {
  return (
    <div className="group/project flex min-w-0 items-center px-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {icon}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {label}
        </span>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
            onClick={onAdd}
          >
            <Plus className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{addHint}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function WorkspaceRow({
  workspace: w,
  selected,
  onSelect,
  onDelete,
  onRename,
  terminalApp,
  editorApp,
  onOpenIn,
}: {
  workspace: Workspace;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: () => void;
  terminalApp?: string;
  editorApp?: string;
  onOpenIn?: (w: Workspace, app?: string) => void;
}) {
  const { diffStats: stats, sessionByWorkspace } = useWorkspaceData();
  const stat = stats[w.id];
  const session = sessionByWorkspace[w.id];
  const isQuickChat = w.kind === "QuickChat";
  // Spinner while the AI is actively working; warning triangle when the backend
  // says the workspace needs the user (pending question, or a finished/unseen
  // turn). Both come straight from the pushed session state.
  const working = session?.activity === "working";
  const needsAttention = !working && session?.needsAttention;

  const row = (
    <div
      className={cn(
        "group/ws ml-4 flex min-w-0 items-center rounded-md hover:bg-sidebar-accent",
        selected && "bg-sidebar-accent",
      )}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
        onClick={onSelect}
      >
        {working ? (
          <Loader2
            className="size-3.5 shrink-0 animate-spin text-primary"
            aria-label="Working"
          />
        ) : needsAttention ? (
          <TriangleAlert
            className="size-3.5 shrink-0 text-warning"
            aria-label="Needs your attention"
          />
        ) : (
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className="min-w-0 flex-1 truncate text-sm"
          title={workspaceLabel(w)}
        >
          {workspaceLabel(w)}
        </span>
        {stat?.files ? (
          <span className="ml-auto shrink-0 font-mono text-[10px]">
            <span className="text-additions">+{stat.insertions}</span>{" "}
            <span className="text-deletions">−{stat.deletions}</span>
          </span>
        ) : (
          w.kind === "Base" && (
            <span className="ml-auto shrink-0 text-[10px] uppercase text-muted-foreground">
              repo
            </span>
          )
        )}
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="mr-1 text-destructive opacity-0 group-hover/ws:opacity-100"
            onClick={onDelete}
          >
            <X className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {isQuickChat ? "Delete quick chat" : "Delete session"}
        </TooltipContent>
      </Tooltip>
    </div>
  );

  if (isQuickChat) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onOpenIn?.(w, terminalApp)}>
          <Terminal className="size-4" /> Open in terminal
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onOpenIn?.(w)}>
          <FolderOpen className="size-4" /> Open in Finder
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onOpenIn?.(w, editorApp)}>
          <Code2 className="size-4" /> Open in IDE
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onRename}>
          <Pencil className="size-4" /> Rename
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 className="size-4" />{" "}
          {w.kind === "Base" ? "Delete base workspace" : "Delete session"}
        </ContextMenuItem>
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
        <DropdownMenuItem disabled>
          <MonitorSmartphone className="size-4" /> Resume remote session…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
