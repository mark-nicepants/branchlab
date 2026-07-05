import { useEffect, useState } from "react";
import { ChevronsUpDown, GitBranch, Plus, Sparkles } from "lucide-react";
import { listBranches } from "../../lib/api";
import type { ProjectView } from "../../lib/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Composer, Kbd } from "../Composer";

interface Props {
  projects: ProjectView[];
  /** Create a worktree session in `projectId` off `base`, seeding `prompt`. */
  onCreateSession: (
    projectId: string,
    base: string | undefined,
    prompt: string,
  ) => void;
  onQuickChat: (prompt: string) => void;
  onAddProject: () => void;
}

/**
 * The Home prompt composer. The bottom rail carries the destination — a
 * project·branch chip pair, or quick chat when the toggle (⌘K) is on — and
 * Enter sends the prompt to whatever the rail currently shows. With no
 * projects registered the toggle hides and quick chat is simply the default.
 */
export function HomeComposer({
  projects,
  onCreateSession,
  onQuickChat,
  onAddProject,
}: Props) {
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState<string | null>(
    projects[0]?.id ?? null,
  );
  const [base, setBase] = useState<string>("");
  const [branches, setBranches] = useState<string[]>([]);
  // Quick-chat send mode. Deliberately component state (not a preference):
  // it resets when Home unmounts, so a stale toggle can't misroute a prompt.
  const [quick, setQuick] = useState(false);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const quickMode = quick || !project;

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

  // ⌘K toggles quick chat from anywhere on Home; the textarea keeps focus.
  useEffect(() => {
    if (!projects.length) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setQuick((q) => !q);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projects.length]);

  function submit() {
    const prompt = text.trim();
    if (!prompt) return;
    if (quickMode) {
      onQuickChat(prompt);
    } else if (project) {
      onCreateSession(project.id, base || undefined, prompt);
    }
    setText("");
  }

  return (
    <div className="w-full">
      <Composer
        value={text}
        onChange={setText}
        onKeyDown={(e) => {
          // Enter sends; Shift/⌘/Ctrl+Enter inserts a newline (same
          // convention as the session composer).
          if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            submit();
            return;
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            // Textareas don't insert a newline on ⌘/Ctrl+Enter natively.
            e.preventDefault();
            const el = e.currentTarget;
            const start = el.selectionStart ?? text.length;
            const end = el.selectionEnd ?? text.length;
            setText(text.slice(0, start) + "\n" + text.slice(end));
            requestAnimationFrame(() => {
              el.selectionStart = el.selectionEnd = start + 1;
            });
          }
        }}
        placeholder={
          quickMode
            ? "Ask anything…"
            : `Describe a task to start in ${project?.name}…`
        }
        frameClassName={quickMode ? "border-primary/40" : undefined}
        hint={
          <>
            <Kbd>Enter</Kbd> to send
            {projects.length > 0 && (
              <>
                {" · "}
                <Kbd>⌘</Kbd> <Kbd>K</Kbd>{" "}
                {quick ? "back to session" : "quick chat"}
              </>
            )}
            {" · "}
            <Kbd>Shift</Kbd> <Kbd>Enter</Kbd> new line
          </>
        }
        controls={
          projects.length === 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={onAddProject}
            >
              <Plus className="size-3.5 opacity-70" /> Add project
            </Button>
          ) : (
            <span
              className={cn(
                "flex items-center gap-1 transition-opacity duration-150",
                quickMode && "pointer-events-none opacity-30",
              )}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5">
                    <GitBranch className="size-3.5 opacity-70" />
                    <span className="max-w-40 truncate">{project?.name}</span>
                    <ChevronsUpDown className="size-3 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[220px]">
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Start a session in
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={projectId ?? ""}
                    onValueChange={setProjectId}
                  >
                    {projects.map((p) => (
                      <DropdownMenuRadioItem key={p.id} value={p.id}>
                        <span className="truncate">{p.name}</span>
                        {p.default_branch && (
                          <span className="ml-auto pl-3 font-mono text-[10px] text-muted-foreground">
                            {p.default_branch}
                          </span>
                        )}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onAddProject}>
                    <Plus className="size-4" /> Add project…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-muted-foreground"
                    disabled={branches.length === 0}
                  >
                    from{" "}
                    <span className="max-w-32 truncate font-mono text-xs text-foreground">
                      {base || "branch"}
                    </span>
                    <ChevronsUpDown className="size-3 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="max-h-72 overflow-y-auto"
                >
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Fork from branch
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={base} onValueChange={setBase}>
                    {branches.map((b) => (
                      <DropdownMenuRadioItem key={b} value={b}>
                        <span className="font-mono text-xs">{b}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          )
        }
        trailing={
          projects.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              aria-pressed={quick}
              onClick={() => setQuick((q) => !q)}
              className={cn(
                "gap-1.5 text-muted-foreground",
                quick &&
                  "border-primary/50 bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary",
              )}
            >
              <Sparkles className="size-3.5" /> Quick chat
              <Kbd>⌘K</Kbd>
            </Button>
          )
        }
        canSend={!!text.trim()}
        onSend={submit}
      />

      {projects.length === 0 && (
        <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3.5" /> No projects yet — your prompt starts
          a context-free quick chat.
        </p>
      )}
    </div>
  );
}
