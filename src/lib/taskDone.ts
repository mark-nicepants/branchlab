// Shared "a task was linked to that workspace" follow-up: deletion only
// unlinks the card (the backend never moves it on its own) — this toast
// offers the user the actual decision.
import { toast } from "sonner";
import { taskMarkDone } from "./api";
import type { UnlinkedTask } from "./types";

export function offerMarkTaskDone(unlinked: UnlinkedTask | null): void {
  if (!unlinked) return;
  toast(`"${unlinked.title}" was linked to that workspace`, {
    description: "Mark the task as done?",
    duration: 10_000,
    action: {
      label: "Mark done",
      onClick: () =>
        void taskMarkDone(unlinked.taskId).catch((e) =>
          toast.error("Could not update task", { description: String(e) }),
        ),
    },
  });
}
