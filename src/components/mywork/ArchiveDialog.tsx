// Read-only transcript viewer for a task whose workspace was cleaned up.
// Shared by the board (the card's "history" chip) and the edit dialog's rail.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { chatArchive } from "../../lib/api";
import type { Entry, Task } from "../../lib/types";
import {
  AssistantTurnView,
  SystemMessageView,
  UserMessageView,
} from "../ChatMessage";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/** Read-only view of a linked session whose workspace was deleted — the
 *  transcript lives on in chat.db, keyed by the (kept) workspace id. */
export function ArchiveDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  useEffect(() => {
    if (!task.workspaceId) return;
    chatArchive(task.workspaceId)
      .then((snap) => setEntries(snap.entries))
      .catch((e) => {
        onClose();
        toast.error("Could not load the archived chat", {
          description: String(e),
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.workspaceId]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[80vh] w-[min(60rem,92vw)] flex-col sm:max-w-none">
        <div className="border-b border-border pb-4">
          <DialogTitle className="text-xl">{task.title}</DialogTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Archived conversation — the workspace was cleaned up.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {entries === null ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading transcript…
            </div>
          ) : entries.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground">
              No messages were recorded for this session.
            </div>
          ) : (
            <div className="flex flex-col gap-3 py-2">
              {entries.map((entry) =>
                entry.type === "user" ? (
                  <UserMessageView key={entry.entryId} entry={entry} />
                ) : entry.type === "assistant" ? (
                  <AssistantTurnView key={entry.entryId} entry={entry} />
                ) : (
                  <SystemMessageView key={entry.entryId} entry={entry} />
                ),
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
