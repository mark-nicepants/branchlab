import { useEffect, useState } from "react";
import { Check, GitBranch } from "lucide-react";
import { toast } from "sonner";
import { createWorkspace, listBranches } from "../lib/api";
import type { ProjectView, Workspace } from "../lib/types";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

interface Props {
  project: ProjectView;
  onClose: () => void;
  onCreated: (workspace: Workspace) => void;
}

/**
 * "New workspace · From branch" — pick the branch to fork from. The new
 * workspace gets a generated codename branch (handled in the backend); the
 * user doesn't name it. ("From PR" etc. become sibling sources later.)
 */
export function NewWorkspaceModal({ project, onClose, onCreated }: Props) {
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState<string>(project.default_branch ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listBranches(project.id)
      .then((bs) => {
        setBranches(bs);
        if (bs.length && !base) setBase(bs[0]);
      })
      .catch((e) => toast.error("Could not list branches", { description: String(e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  async function create() {
    if (!base || busy) return;
    setBusy(true);
    try {
      const ws = await createWorkspace(project.id, base);
      onCreated(ws);
      onClose();
    } catch (e) {
      toast.error("Could not create workspace", { description: String(e) });
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New workspace in {project.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">From branch</label>
          <Command>
            <CommandInput placeholder="Search or enter a branch…" />
            <CommandList className="max-h-60">
              <CommandEmpty>No branches.</CommandEmpty>
              <CommandGroup>
                {branches.map((b) => (
                  <CommandItem key={b} value={b} onSelect={() => setBase(b)}>
                    <GitBranch className="size-3.5 text-muted-foreground" />
                    <span className="font-mono text-xs">{b}</span>
                    <Check className={cn("ml-auto size-3.5", base === b ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={busy || !base}>
            {busy ? "Creating…" : "Create workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
