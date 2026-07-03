import { Check, ChevronDown, GitPullRequest, Upload } from "lucide-react";
import type { ProjectView, Workspace } from "../lib/types";
import type { WorkspaceAction } from "./Chat";
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
  create_pr: "Opening pull request on GitHub…",
} as const;

/**
 * Base prompt for opening a PR. The assistant figures out the title and body
 * itself, so no user input is collected up front. `base`/`branch` are
 * interpolated so the git commands reference the workspace's actual branches;
 * `extra` carries the project's configured create_pr prompt when present.
 */
function buildPrPrompt(base: string, branch: string, extra?: string) {
  const branchRef = branch || "HEAD";
  return `${extra ? `${extra}\n\n` : ""}Create a pull request for the changes on this branch.

Steps:
1. Check for uncommitted changes with \`git status --porcelain\`
2. If there are uncommitted changes, stage them all with \`git add -A\` and commit with a meaningful short message that describes the changes
3. Review the diff against the base branch. If the repo has a remote, first run \`git fetch origin "${base}"\` and review \`git diff origin/${base}...HEAD\` — GitHub diffs the PR against the remote base, and the local \`${base}\` ref may be stale, which would inflate the diff with already-merged commits. If there is no remote, use \`git diff ${base}...HEAD\`.
4. Push the branch to the remote: \`git push -u origin "${branchRef}"\`
5. Create the pull request using the GitHub CLI:
   Use \`gh pr create --base ${base}\` with a meaningful title and body.
   Write a concise title summarizing the change.
   Write a PR body that describes what was changed and why.
   If the workspace is linked to a GitHub issue, reference it in the PR body.
   Pass the base branch via --base, the title via --title, and the body via --body.

After creating the PR, output the PR URL on its own line so it can be detected.`;
}

export function CommitButton({ workspace, project, onAction }: Props) {
  const prompts = project.prompts;
  const base = workspace.base_branch ?? "main";

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

  function openPr() {
    const prompt = buildPrPrompt(
      base,
      workspace.branch ?? "",
      prompts.create_pr?.trim() || undefined,
    );
    onAction({
      kind: "pr",
      prompt,
      display: DISPLAY.create_pr,
      onFinish: {
        kind: "remove_workspace",
        message: "Pull request opened! Do you want to remove the workspace?",
      },
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
        <DropdownMenuContent align="end" side="bottom" className="min-w-[200px]">
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
          <DropdownMenuItem onClick={openPr}>
            <GitPullRequest className="size-4" />
            Push & open PR
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
