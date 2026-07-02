import { useEffect, useState } from "react";
import { ArrowUp, ChevronsUpDown, FolderPlus, GitBranch, Plus, Sparkles } from "lucide-react";
import { listBranches } from "../../lib/api";
import type { ProjectView } from "../../lib/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface Props {
  projects: ProjectView[];
  /** Create a worktree session in `projectId` off `base`, seeding `prompt`. */
  onCreateSession: (projectId: string, base: string | undefined, prompt: string) => void;
  onQuickChat: (prompt: string) => void;
  onAddProject: () => void;
}

/**
 * The Home prompt composer. Submitting spins up a new worktree session in the
 * selected project (or a quick chat when no project is selected), seeding the
 * agent with the typed prompt. Mode/model pills are display-only here — the
 * live selectors live inside the session composer.
 */
export function HomeComposer({ projects, onCreateSession, onQuickChat, onAddProject }: Props) {
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState<string | null>(projects[0]?.id ?? null);
  const [base, setBase] = useState<string>("");
  const [branches, setBranches] = useState<string[]>([]);

  const project = projects.find((p) => p.id === projectId) ?? null;

  // Default the selected project once projects load.
  useEffect(() => {
    if (!projectId && projects.length) setProjectId(projects[0].id);
  }, [projects, projectId]);

  // Load branches for the selected project.
  useEffect(() => {
    if (!project) {
      setBranches([]);
      setBase("");
      return;
    }
    setBase(project.default_branch ?? "");
    listBranches(project.id)
      .then((bs) => setBranches(bs))
      .catch(() => setBranches([]));
  }, [project?.id]);

  function submit() {
    const prompt = text.trim();
    if (!prompt) return;
    if (project) {
      onCreateSession(project.id, base || undefined, prompt);
    } else {
      onQuickChat(prompt);
    }
    setText("");
  }

  return (
    <div className="w-full">
      <div className="rounded-2xl border border-border bg-card transition-colors duration-150 focus-within:border-ring">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask anything, or describe a task to start a session…  (⌘/Ctrl+Enter)"
          className="min-h-[76px] resize-none border-0 bg-transparent px-4 pt-3.5 text-[15px] shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" disabled>
                <Plus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Attach · in session</TooltipContent>
          </Tooltip>
          <DisplayPill label="Interactive" hint="Autonomy is chosen per session" />
          <DisplayPill label="Auto" hint="Model is chosen per session" />
          <div className="ml-auto">
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-primary hover:bg-primary/10 disabled:text-muted-foreground/40"
              onClick={submit}
              disabled={!text.trim()}
            >
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Target selectors */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-sm">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5" disabled={projects.length === 0}>
              <FolderPlus className="size-3.5 opacity-70" />
              <span className="max-w-40 truncate">{project?.name ?? "No project"}</span>
              <ChevronsUpDown className="size-3.5 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[200px]">
            <DropdownMenuRadioGroup value={projectId ?? ""} onValueChange={setProjectId}>
              {projects.map((p) => (
                <DropdownMenuRadioItem key={p.id} value={p.id}>
                  <span className="truncate">{p.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground">
          <GitBranch className="size-3.5" /> New worktree
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5" disabled={!project || branches.length === 0}>
              <span className="max-w-32 truncate font-mono text-xs">{base || "branch"}</span>
              <ChevronsUpDown className="size-3.5 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            <DropdownMenuRadioGroup value={base} onValueChange={setBase}>
              {branches.map((b) => (
                <DropdownMenuRadioItem key={b} value={b}>
                  <span className="font-mono text-xs">{b}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="ghost" size="sm" className="ml-auto gap-1.5 text-muted-foreground" onClick={onAddProject}>
          <Plus className="size-3.5" /> Add project
        </Button>
      </div>

      {projects.length === 0 && (
        <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3.5" /> No project selected — your prompt starts a context-free quick chat.
        </p>
      )}
    </div>
  );
}

/** Non-interactive pill mirroring the session composer's selectors. */
function DisplayPill({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "flex cursor-default items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground",
          )}
        >
          {label}
          <ChevronsUpDown className="size-3 opacity-40" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
