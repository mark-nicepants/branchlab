import { Check, ChevronDown, GitPullRequest, Upload } from "lucide-react";
import { useState } from "react";
import type { ProjectView, Workspace } from "../lib/types";
import type { WorkspaceAction } from "./Chat";
import { CreatePrDialog } from "./CreatePrDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Props {
  workspace: Workspace;
  project: ProjectView;
  onAction: (action: WorkspaceAction) => void;
}

const DISPLAY = {
  commit: "Committing changes…",
  merge: "Merging workspace into main…",
  push: "Pushing branch to GitHub…",
} as const;

export function CommitButton({ workspace, project, onAction }: Props) {
  const prompts = project.prompts;
  const base = workspace.base_branch ?? "main";
  const [prOpen, setPrOpen] = useState(false);
  // Fork PRs are read-only — no push access back to the fork.
  const canOpenPr = !workspace.pr_is_fork;

  function send(kind: "commit" | "merge" | "push") {
    const prompt = prompts[kind] ?? "";
    const display = DISPLAY[kind];
    onAction({
      kind,
      prompt,
      display,
      onFinish:
        kind === "merge"
          ? {
              kind: "remove_workspace",
              message: "Merge successful! Do you want to remove the workspace?",
            }
          : undefined,
    });
  }

  return (
    <div className="flex items-center">
      <Button
        size="sm"
        className="h-7 gap-1.5 rounded-r-none px-2.5 text-xs"
        onClick={() => send("commit")}
      >
        <Check className="size-3.5" />
        Commit
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="default"
            className="h-7 rounded-l-none border-l border-primary-foreground/30 px-1.5 text-xs"
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="bottom"
          className="min-w-[200px]"
        >
          <DropdownMenuItem onClick={() => send("commit")}>
            <Check className="size-4" />
            Commit changes
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => send("merge")}>
            <ChevronDown className="size-4 rotate-[-90deg]" />
            Merge into {base}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => send("push")}>
            <Upload className="size-4" />
            Push branch to GitHub
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setPrOpen(true)}
            disabled={!canOpenPr}
          >
            <GitPullRequest className="size-4" />
            Push & open PR
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {prOpen && (
        <CreatePrDialog
          workspace={workspace}
          onClose={() => setPrOpen(false)}
        />
      )}
    </div>
  );
}
