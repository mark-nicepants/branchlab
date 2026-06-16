import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PanelLeft, PanelRight, Settings } from "lucide-react";

interface Props {
  project: string | null;
  branch: string | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  /** Whether the right (changes) panel exists for the current view. */
  rightAvailable: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onOpenSettings: () => void;
}

/**
 * Custom window titlebar. On macOS the window uses the Overlay title-bar style,
 * so native traffic lights sit at the top-left and our content extends beneath;
 * the `pl-[78px]` reserves room for them. The whole bar is a drag region except
 * the interactive buttons.
 */
export function Titlebar({
  project,
  branch,
  leftCollapsed,
  rightCollapsed,
  rightAvailable,
  onToggleLeft,
  onToggleRight,
  onOpenSettings,
}: Props) {
  return (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-sidebar pr-2 pl-[78px] text-sm"
    >
      <div className="flex items-center gap-0.5">
        <PanelToggle active={!leftCollapsed} onClick={onToggleLeft} side="left" hint="Toggle sidebar  ⌘B" />
      </div>

      <div data-tauri-drag-region className="flex flex-1 items-center justify-center gap-1.5">
        {project ? (
          <>
            <span className="text-muted-foreground">{project}</span>
            {branch && (
              <>
                <span className="text-muted-foreground/50">/</span>
                <span className="font-medium">{branch}</span>
              </>
            )}
          </>
        ) : (
          <span className="font-medium text-muted-foreground">BranchLab</span>
        )}
      </div>

      <div className="flex items-center gap-0.5">
        {rightAvailable && (
          <PanelToggle active={!rightCollapsed} onClick={onToggleRight} side="right" hint="Toggle changes  ⌘D" />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" onClick={onOpenSettings}>
              <Settings className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings  ⌘,</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

function PanelToggle({
  active,
  onClick,
  side,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  side: "left" | "right";
  hint: string;
}) {
  const Icon = side === "left" ? PanelLeft : PanelRight;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-7", active ? "text-foreground" : "text-muted-foreground")}
          onClick={onClick}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
