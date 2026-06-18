import { useState } from "react";
import { Check, ChevronDown, GitPullRequest, Upload } from "lucide-react";
import { toast } from "sonner";
import type { ProjectPrompts, ProjectView, Workspace } from "../lib/types";
import type { WorkspaceAction } from "./Chat";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  workspace: Workspace;
  project: ProjectView;
  onAction: (action: WorkspaceAction) => void;
}

const DEFAULT_PROMPTS: Required<ProjectPrompts> = {
  init_workspace: "Set up the new workspace.",
  commit: "Stage all changes in this workspace with git add -A, then commit with a clear, concise conventional commit message that summarizes the diff. Do not push.",
  merge: "Merge this workspace's branch into the base/main branch of the repository. First run the git commands from this workspace directory. Then switch to the base branch in the parent repository, merge this workspace's branch into it, and push the result to origin. Confirm the merge succeeded.",
  push: "Push the current workspace branch to the origin remote. Confirm the remote and branch name.",
  create_pr: "Push the current workspace branch to origin and open a GitHub pull request against the base branch using gh pr create. Use a clear title and description based on the changes.",
};

const DISPLAY: Record<Exclude<keyof ProjectPrompts, "init_workspace">, string> = {
  commit: "Committing changes…",
  merge: "Merging workspace into main…",
  push: "Pushing branch to GitHub…",
  create_pr: "Opening pull request on GitHub…",
};

export function CommitButton({ workspace, project, onAction }: Props) {
  const [prOpen, setPrOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const prompts = project.prompts;
  const branch = workspace.branch ?? "this branch";
  const base = workspace.base_branch ?? "main";

  function send(kind: "commit" | "merge" | "push") {
    const prompt = (prompts[kind] ?? DEFAULT_PROMPTS[kind]) || "";
    const display = DISPLAY[kind];
    onAction({
      kind,
      prompt,
      display,
      onFinish: kind === "merge" ? { kind: "remove_workspace", message: "Merge successful! Do you want to remove the workspace?" } : undefined,
    });
  }

  function openPr() {
    const t = title.trim();
    if (!t) {
      toast.error("Enter a PR title");
      return;
    }
    const prompt = (prompts.create_pr ?? DEFAULT_PROMPTS.create_pr) || "";
    const display = DISPLAY.create_pr;
    const promptWithInputs = `${prompt} Use PR title: "${t}"${body.trim() ? ` and description: """${body.trim()}"""` : ""}.`;
    onAction({
      kind: "pr",
      title: t,
      body: body.trim(),
      prompt: promptWithInputs,
      display,
      onFinish: { kind: "remove_workspace", message: "Pull request opened! Do you want to remove the workspace?" },
    });
    setPrOpen(false);
    setTitle("");
    setBody("");
  }

  return (
    <>
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
            <DropdownMenuItem onClick={() => setPrOpen(true)}>
              <GitPullRequest className="size-4" />
              Push & open PR…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={prOpen} onOpenChange={setPrOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Open pull request</DialogTitle>
            <DialogDescription>
              Push <span className="font-mono">{branch}</span> to origin and create a PR against{" "}
              <span className="font-mono">{base}</span>.
            </DialogDescription>
          </DialogHeader>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="PR title" className="mt-2" />
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="PR description (optional)"
            className="mt-2 min-h-[80px]"
          />
          <DialogFooter className="mt-4">
            <Button variant="secondary" size="sm" onClick={() => setPrOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={openPr}>Create PR</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
