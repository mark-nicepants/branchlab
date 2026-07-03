import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useWorkspaceData } from "../hooks/useWorkspaceData";
import { commitWorkspace, createWorkspacePr, openExternal } from "../lib/api";
import { workspaceLabel, type Workspace } from "../lib/types";

interface Props {
  workspace: Workspace;
  onClose: () => void;
  /** Called after the PR is opened, with its URL (parent may offer to remove). */
  onCreated?: (url: string) => void;
}

/**
 * Push the branch and open a PR via the typed backend command (replacing the
 * old AI-prompted flow). Gates on uncommitted changes — the API pushes an
 * existing branch, so anything uncommitted wouldn't be in the PR.
 */
export function CreatePrDialog({ workspace, onClose, onCreated }: Props) {
  const { diffStats } = useWorkspaceData();
  const dirty = (diffStats[workspace.id]?.files ?? 0) > 0;
  const base = workspace.base_branch ?? "main";

  const [title, setTitle] = useState(workspaceLabel(workspace));
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(commitFirst: boolean) {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      if (commitFirst) {
        await commitWorkspace(workspace.id, `${title.trim()}`);
      }
      const res = await createWorkspacePr(workspace.id, title.trim(), body);
      toast.success("Pull request opened", {
        action: { label: "Open", onClick: () => void openExternal(res.url) },
      });
      onCreated?.(res.url);
      onClose();
    } catch (e) {
      toast.error("Could not open PR", { description: String(e) });
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-full max-w-md">
        <DialogHeader>
          <DialogTitle>Open a pull request</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">
              Description (optional)
            </label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What changed and why…"
              className="min-h-[100px] text-xs"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Opens against <span className="font-mono">{base}</span>.
          </p>
          {dirty && (
            <div className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                You have uncommitted changes — they won't be in the PR unless
                you commit them first.
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {dirty && (
            <Button
              variant="outline"
              onClick={() => void submit(true)}
              disabled={busy || !title.trim()}
            >
              Commit &amp; open PR
            </Button>
          )}
          <Button
            onClick={() => void submit(false)}
            disabled={busy || !title.trim()}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ExternalLink className="size-4" />
            )}
            Open PR
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
