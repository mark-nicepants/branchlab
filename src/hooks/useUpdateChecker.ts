import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { useEffect } from "react";
import { toast } from "sonner";

/** Re-check for updates this often while the app stays open. */
const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Polls the update endpoint (on launch, then every few hours) and surfaces a
 * persistent toast when a newer version is available. One click downloads the
 * signed update, installs it over the current .app, and relaunches.
 */
export function useUpdateChecker() {
  useEffect(() => {
    let notifiedVersion: string | null = null;

    const checkForUpdate = async () => {
      let update;
      try {
        update = await check();
      } catch {
        // Offline, endpoint unreachable, or browser debug mode — try again
        // next interval.
        return;
      }
      if (!update || update.version === notifiedVersion) return;
      notifiedVersion = update.version;

      toast(`BranchLab ${update.version} is available`, {
        id: "app-update",
        description: update.body || undefined,
        duration: Infinity,
        action: {
          label: "Update & restart",
          onClick: async () => {
            const progress = toast.loading("Downloading update…", {
              id: "app-update",
              duration: Infinity,
            });
            try {
              await update.downloadAndInstall();
              await relaunch();
            } catch (e) {
              toast.error("Update failed", {
                id: progress,
                description: e instanceof Error ? e.message : String(e),
                duration: 8000,
              });
            }
          },
        },
      });
    };

    void checkForUpdate();
    const interval = setInterval(
      () => void checkForUpdate(),
      RECHECK_INTERVAL_MS,
    );
    return () => clearInterval(interval);
  }, []);
}
