// Shared workspace-delete flow: try a safe delete first; when the backend
// refuses because of uncommitted changes, offer a force delete via toast.
import { toast } from "sonner";
import { removeWorkspace } from "./api";
import type { UnlinkedTask } from "./types";

/** Stable error-code prefix the backend's safe-delete refusal starts with
 *  (`"uncommitted_changes: …"`). A code, not prose, so rewording the message
 *  can't break the routing — mirrors `remove_workspace` in
 *  `src-tauri/src/project.rs`; keep the two in sync. */
export const UNCOMMITTED_CODE = "uncommitted_changes";

export async function deleteWorkspaceWithConfirm(
  id: string,
  onDone: (unlinked: UnlinkedTask | null) => void,
): Promise<void> {
  try {
    onDone(await removeWorkspace(id, false));
  } catch (e) {
    const uncommitted = String(e).startsWith(UNCOMMITTED_CODE);
    toast.error(
      uncommitted
        ? "Workspace has uncommitted changes"
        : "Could not delete workspace",
      {
        description: uncommitted ? "Deleting it will discard them." : String(e),
        action: {
          label: "Delete anyway",
          onClick: () =>
            void removeWorkspace(id, true)
              .then(onDone)
              .catch((e2) =>
                toast.error("Could not delete workspace", {
                  description: String(e2),
                }),
              ),
        },
      },
    );
  }
}
