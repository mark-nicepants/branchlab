import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { TabBarItem } from "@/components/ui/tab-bar";
import { fileStatus } from "@/lib/status";
import { buildTree, type TreeNode } from "@/lib/tree";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  File,
  FileDiff,
  Folder,
  Search,
  SquareArrowOutUpRight,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useWorkspaceData } from "../../hooks/useWorkspaceData";
import { openExternal, workspaceFiles } from "../../lib/api";
import {
  turnFilePaths,
  type ChangeScope,
  type LastTurnInfo,
} from "../../lib/review";
import type { Workspace } from "../../lib/types";
import { HiddenFilesNote, ScopeToggle } from "../center/ChangesView";
import { usePreferences } from "../PreferencesProvider";
import { ServerToolsPanel } from "../session/ServerToolsPanel";

interface Props {
  workspace: Workspace | null;
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
  onOpenFile: (path: string) => void;
  /** Open a file in the in-app viewer (center "file" tab). */
  onViewFile: (path: string) => void;
  /** Restart the workspace's ACP engine (Config tab). */
  onRestart?: () => void;
  /** Extra controls rendered at the right edge of the tab header. */
  actions?: React.ReactNode;
  /** Last-turn info + shared scope, kept in sync with the diff view. */
  lastTurn: LastTurnInfo | null;
  scope: ChangeScope;
  onScopeChange: (s: ChangeScope) => void;
}

type Tab = "changes" | "files" | "config";

export function ChangesPanel({
  workspace,
  viewed,
  onToggleViewed,
  onOpenFile,
  onViewFile,
  onRestart,
  actions,
  lastTurn,
  scope,
  onScopeChange,
}: Props) {
  const [tab, setTab] = useState<Tab>("changes");

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <header className="flex items-center gap-1 border-b border-border px-3">
        <TabBarItem
          active={tab === "changes"}
          onClick={() => setTab("changes")}
        >
          Changes
        </TabBarItem>
        <TabBarItem active={tab === "files"} onClick={() => setTab("files")}>
          Files
        </TabBarItem>
        <TabBarItem active={tab === "config"} onClick={() => setTab("config")}>
          Config
        </TabBarItem>
        {actions && <div className="ml-auto py-1">{actions}</div>}
      </header>

      {!workspace ? (
        <EmptyIcon>Select a workspace to see its changes.</EmptyIcon>
      ) : tab === "changes" ? (
        <ChangesTab
          workspace={workspace}
          viewed={viewed}
          onToggleViewed={onToggleViewed}
          onOpenFile={onOpenFile}
          lastTurn={lastTurn}
          scope={scope}
          onScopeChange={onScopeChange}
        />
      ) : tab === "files" ? (
        <FilesTab workspace={workspace} onViewFile={onViewFile} />
      ) : (
        <ServerToolsPanel
          workspaceId={workspace.id}
          onRestart={() => onRestart?.()}
        />
      )}
    </div>
  );
}

/** Local: empty state with the file-diff icon used in this panel. */
function EmptyIcon({ children }: { children: React.ReactNode }) {
  return (
    <EmptyState icon={<FileDiff className="size-6 text-muted-foreground/60" />}>
      {children}
    </EmptyState>
  );
}

// ── Changes tab: the changed-files list ──

function ChangesTab({
  viewed,
  onToggleViewed,
  onOpenFile,
  lastTurn,
  scope,
  onScopeChange,
}: {
  workspace: Workspace;
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
  onOpenFile: (path: string) => void;
  lastTurn: LastTurnInfo | null;
  scope: ChangeScope;
  onScopeChange: (s: ChangeScope) => void;
}) {
  const [filter, setFilter] = useState("");
  const { changes } = useWorkspaceData();
  const files = changes ?? [];

  const turnPaths = useMemo(
    () => turnFilePaths(files, lastTurn),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files.map((f) => f.path).join(","), lastTurn],
  );
  const effScope: ChangeScope =
    scope === "turn" && turnPaths.size > 0 ? "turn" : "all";
  const scoped =
    effScope === "turn" ? files.filter((f) => turnPaths.has(f.path)) : files;
  const shown = scoped.filter((f) =>
    f.path.toLowerCase().includes(filter.toLowerCase()),
  );
  const hiddenCount = files.length - scoped.length;

  if (files.length === 0) return <EmptyIcon>No changes yet</EmptyIcon>;

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2">
        <ScopeToggle
          scope={effScope}
          turnCount={turnPaths.size}
          allCount={files.length}
          onChange={onScopeChange}
        />
        <div className="relative ml-auto w-40">
          <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto pb-1">
        {effScope === "turn" && hiddenCount > 0 && (
          <HiddenFilesNote
            count={hiddenCount}
            onShowAll={() => onScopeChange("all")}
          />
        )}
        {shown.map((f) => {
          const slash = f.path.lastIndexOf("/");
          const dir = slash >= 0 ? f.path.slice(0, slash + 1) : "";
          const name = slash >= 0 ? f.path.slice(slash + 1) : f.path;
          const s = fileStatus(f.status);
          return (
            <div
              key={f.path}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent",
                viewed.has(f.path) && "opacity-60",
              )}
            >
              <span
                className={cn(
                  "w-3 shrink-0 text-center font-mono text-xs font-semibold",
                  s.className,
                )}
              >
                {s.letter}
              </span>
              <button
                className="flex min-w-0 flex-1 text-left"
                onClick={() => onOpenFile(f.path)}
                title={f.path}
              >
                <span className="min-w-0 flex-1 truncate">
                  {dir && <span className="text-muted-foreground">{dir}</span>}
                  {name}
                </span>
              </button>
              <span className="shrink-0 font-mono text-[11px]">
                {f.insertions > 0 && (
                  <span className="text-additions">+{f.insertions}</span>
                )}{" "}
                {f.deletions > 0 && (
                  <span className="text-deletions">−{f.deletions}</span>
                )}
              </span>
              <button
                className="shrink-0 text-muted-foreground hover:text-foreground"
                title={viewed.has(f.path) ? "Mark not viewed" : "Mark viewed"}
                onClick={() => onToggleViewed(f.path)}
              >
                {viewed.has(f.path) ? (
                  <CheckCircle2 className="size-4 text-additions" />
                ) : (
                  <Circle className="size-4" />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Files tab: a browsable file tree ──

function FilesTab({
  workspace,
  onViewFile,
}: {
  workspace: Workspace;
  onViewFile: (path: string) => void;
}) {
  const { prefs } = usePreferences();
  const [paths, setPaths] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    workspaceFiles(workspace.id)
      .then(setPaths)
      .catch(() => {});
  }, [workspace.id]);

  const tree = useMemo(() => buildTree(paths), [paths]);

  function toggle(path: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }

  function openExternally(path: string) {
    openExternal(`${workspace.path}/${path}`, prefs.editorApp).catch((e) =>
      toast.error("Could not open", { description: String(e) }),
    );
  }

  if (paths.length === 0) return <EmptyIcon>No files.</EmptyIcon>;

  return (
    <div className="flex-1 overflow-auto py-1 text-sm">
      {tree.map((n) => (
        <TreeRow
          key={n.path}
          node={n}
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          onViewFile={onViewFile}
          onOpenExternally={openExternally}
        />
      ))}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  onViewFile,
  onOpenExternally,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onViewFile: (path: string) => void;
  onOpenExternally: (path: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  return (
    <>
      <div
        className="group flex w-full items-center gap-1.5 pr-2 hover:bg-accent"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
          onClick={() =>
            node.isFile ? onViewFile(node.path) : onToggle(node.path)
          }
          title={node.path}
        >
          {node.isFile ? (
            <File className="size-3.5 shrink-0 text-muted-foreground" />
          ) : isOpen ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          {!node.isFile && (
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {node.isFile && (
          <button
            className="shrink-0 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
            title="Open in external editor"
            onClick={() => onOpenExternally(node.path)}
          >
            <SquareArrowOutUpRight className="size-3.5" />
          </button>
        )}
      </div>
      {!node.isFile &&
        isOpen &&
        node.children.map((c) => (
          <TreeRow
            key={c.path}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            onViewFile={onViewFile}
            onOpenExternally={onOpenExternally}
          />
        ))}
    </>
  );
}
