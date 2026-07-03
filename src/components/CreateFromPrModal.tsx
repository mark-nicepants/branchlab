import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GitFork, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createWorkspaceFromPr, listProjectPrs } from "../lib/api";
import type { PrSummary, ProjectView, Workspace } from "../lib/types";
import { AccountAvatar } from "./github/AccountAvatar";

interface Props {
  project: ProjectView;
  onClose: () => void;
  onCreated: (workspace: Workspace) => void;
}

const GROUPS: { bucket: PrSummary["bucket"]; label: string }[] = [
  { bucket: "mine", label: "Your pull requests" },
  { bucket: "review_requested", label: "Review requested" },
  { bucket: "assigned", label: "Assigned to you" },
];

/**
 * "New workspace · From pull request" — pick an open PR (yours, review-
 * requested, or assigned) and check it out into a fresh worktree.
 */
export function CreateFromPrModal({ project, onClose, onCreated }: Props) {
  const [prs, setPrs] = useState<PrSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listProjectPrs(project.id)
      .then(setPrs)
      .catch((e) => setError(String(e)));
  }, [project.id]);

  async function checkout(number: number) {
    if (busy) return;
    setBusy(true);
    try {
      const ws = await createWorkspaceFromPr(project.id, number);
      onCreated(ws);
      onClose();
    } catch (e) {
      toast.error("Could not check out PR", { description: String(e) });
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-full max-w-lg">
        <DialogHeader>
          <DialogTitle>Check out a pull request · {project.name}</DialogTitle>
        </DialogHeader>

        {error ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {error}
          </p>
        ) : prs === null ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading pull requests…
          </div>
        ) : (
          <Command>
            <CommandInput placeholder="Search PRs by title, number, or author…" />
            <CommandList className="max-h-80">
              <CommandEmpty>No open pull requests.</CommandEmpty>
              {GROUPS.map(({ bucket, label }) => {
                const group = prs.filter((p) => p.bucket === bucket);
                if (group.length === 0) return null;
                return (
                  <CommandGroup key={bucket} heading={label}>
                    {group.map((pr) => (
                      <CommandItem
                        key={pr.number}
                        value={`${pr.number} ${pr.title} ${pr.author}`}
                        onSelect={() => void checkout(pr.number)}
                        className="flex items-start gap-2"
                        disabled={busy}
                      >
                        <span className="mt-0.5 font-mono text-xs text-muted-foreground">
                          #{pr.number}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm">{pr.title}</span>
                            {pr.isFork && (
                              <GitFork className="size-3 shrink-0 text-muted-foreground" />
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <AccountAvatar
                              account={{
                                login: pr.author,
                                avatarUrl: pr.authorAvatar,
                              }}
                              className="size-3.5"
                            />
                            <span className="truncate">
                              {pr.author} · {pr.headRef}
                            </span>
                          </div>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })}
            </CommandList>
          </Command>
        )}

        {busy && (
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Checking out…
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
