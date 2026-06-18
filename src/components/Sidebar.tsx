import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  LayoutGrid,
  MoreVertical,
  Pencil,
  Plus,
  Settings,
  Terminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { openExternal, removeProject, removeWorkspace, renameWorkspace } from "../lib/api";
import { workspaceLabel, type ProjectView, type Workspace } from "../lib/types";
import { useWorkspaceData } from "../hooks/useWorkspaceData";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePreferences } from "./PreferencesProvider";
import { cn } from "@/lib/utils";

interface Props {
  projects: ProjectView[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (w: Workspace) => void;
  onProjectsChanged: () => void;
  onShowFleet: () => void;
  onQuickCreate: (project: ProjectView) => void;
  onNewFromBranch: (project: ProjectView) => void;
  onAddProject: () => void;
  onOpenSettings: (project: ProjectView) => void;
}

export function Sidebar({
  projects,
  selectedWorkspaceId,
  onSelectWorkspace,
  onProjectsChanged,
  onShowFleet,
  onQuickCreate,
  onNewFromBranch,
  onAddProject,
  onOpenSettings,
}: Props) {
  const { prefs, setPref } = usePreferences();
  const { diffStats: stats } = useWorkspaceData();
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(Object.entries(prefs.collapsedProjects).filter(([, v]) => v).map(([k]) => k)),
  );

  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const collapsedRecord: Record<string, boolean> = { ...prefs.collapsedProjects };
      if (next.has(id)) collapsedRecord[id] = true;
      else delete collapsedRecord[id];
      setPref("collapsedProjects", collapsedRecord);
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

  async function saveRename() {
    const name = renameValue.trim();
    if (renaming && name) {
      await renameWorkspace(renaming.id, name);
      onProjectsChanged();
    }
    setRenaming(null);
  }

  function openIn(w: Workspace, app?: string) {
    openExternal(w.path, app).catch((e) => toast.error("Could not open", { description: String(e) }));
  }

  return (
    <aside className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      <button
        className="mx-1 mt-2 mb-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent"
        onClick={onShowFleet}
      >
        <LayoutGrid className="size-3.5 shrink-0" />
        Fleet
      </button>

      <ScrollArea className="flex-1">
        <div className="px-1 pb-2">
          {projects.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No projects yet. Add a git repository below.
            </p>
          )}

          {projects.map((p) => (
            <div key={p.id} className="group/project mb-2">
              <div className="flex items-center justify-between px-2 py-1">
                <button
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  onClick={() => toggleCollapsed(p.id)}
                >
                  {collapsed.has(p.id) ? (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate text-[13px] font-semibold uppercase tracking-wide" title={p.name}>
                    {p.name}
                  </span>
                </button>
                <span className="flex shrink-0 items-center text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-6" onClick={() => onQuickCreate(p)}>
                        <Plus className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>New workspace from base repo</TooltipContent>
                  </Tooltip>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-6">
                        <MoreVertical className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Plus className="size-4" /> New workspace
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuItem onClick={() => onNewFromBranch(p)}>
                            <GitBranch className="size-4" /> From branch
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled>
                            <GitPullRequest className="size-4" /> From pull request
                          </DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      <DropdownMenuItem onClick={() => onOpenSettings(p)}>
                        <Settings className="size-4" /> Project settings
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => void removeProject(p.id).then(onProjectsChanged)}
                      >
                        <Trash2 className="size-4" /> Remove project
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              </div>

              {!collapsed.has(p.id) &&
                p.workspaces.map((w) => (
                <ContextMenu key={w.id}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={cn(
                        "group/ws flex items-center hover:bg-sidebar-accent",
                        w.id === selectedWorkspaceId && "bg-sidebar-accent",
                      )}
                    >
                      <button
                        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
                        onClick={() => onSelectWorkspace(w)}
                      >
                        <span className="size-3.5 shrink-0" />
                        <span className="truncate text-sm" title={workspaceLabel(w)}>{workspaceLabel(w)}</span>
                        {stats[w.id]?.files ? (
                          <span className="ml-auto shrink-0 font-mono text-[10px]">
                            <span className="text-additions">+{stats[w.id].insertions}</span>{" "}
                            <span className="text-deletions">−{stats[w.id].deletions}</span>
                          </span>
                        ) : (
                          w.kind === "Base" && (
                            <span className="ml-auto shrink-0 text-[10px] uppercase text-muted-foreground">
                              repo
                            </span>
                          )
                        )}
                      </button>
                      {w.kind === "Worktree" && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="mr-1 size-6 text-destructive opacity-0 group-hover/ws:opacity-100"
                              onClick={() => void deleteWorkspace(w)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete workspace</TooltipContent>
                        </Tooltip>
                      )}
                      {w.kind === "Base" && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="mr-1 size-6 text-destructive opacity-0 group-hover/ws:opacity-100"
                              onClick={() => void deleteWorkspace(w)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete base workspace</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => openIn(w, prefs.terminalApp)}>
                      <Terminal className="size-4" /> Open in terminal
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => openIn(w)}>
                      <FolderOpen className="size-4" /> Open in Finder
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => openIn(w, prefs.editorApp)}>
                      <Code2 className="size-4" /> Open in IDE
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => startRename(w)}>
                      <Pencil className="size-4" /> Rename
                    </ContextMenuItem>
                    {w.kind === "Worktree" && (
                      <ContextMenuItem variant="destructive" onClick={() => void deleteWorkspace(w)}>
                        <Trash2 className="size-4" /> Delete workspace
                      </ContextMenuItem>
                    )}
                    {w.kind === "Base" && (
                      <ContextMenuItem variant="destructive" onClick={() => void deleteWorkspace(w)}>
                        <Trash2 className="size-4" /> Delete base workspace
                      </ContextMenuItem>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </div>
          ))}
        </div>
      </ScrollArea>

      <div className="border-t border-sidebar-border p-2">
        <Button variant="ghost" className="w-full justify-start gap-2" onClick={onAddProject}>
          <FolderPlus className="size-4" /> New project
        </Button>
      </div>

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="w-full max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveRename()}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button onClick={() => void saveRename()} disabled={!renameValue.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
