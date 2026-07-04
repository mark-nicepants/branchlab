// App-update state, shared across the UI. The provider polls the update
// endpoint (on launch, then every few hours — gated on the "Automatically
// check for updates" preference), surfaces a small toast when a new version
// appears, and exposes the pending update so the sidebar can badge the
// settings gear and Settings → General can render an update banner.
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { usePreferences } from "@/components/PreferencesProvider";

/** Re-check for updates this often while the app stays open. */
const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface UpdateCtxValue {
  /** Version string of a pending update, or null when up to date. */
  availableVersion: string | null;
  /** True while an update is downloading/installing. */
  installing: boolean;
  /** Download the pending update, install over the current .app, relaunch. */
  installUpdate: () => Promise<void>;
}

const UpdateCtx = createContext<UpdateCtxValue>({
  availableVersion: null,
  installing: false,
  installUpdate: async () => {},
});

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const { prefs } = usePreferences();
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  // The Update handle isn't renderable state; keep it out of React's diffing.
  const updateRef = useRef<Update | null>(null);
  const notifiedVersion = useRef<string | null>(null);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setInstalling(true);
    const progress = toast.loading("Downloading update…", {
      id: "app-update",
      duration: Infinity,
    });
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setInstalling(false);
      toast.error("Update failed", {
        id: progress,
        description: e instanceof Error ? e.message : String(e),
        duration: 8000,
      });
    }
  }, []);

  useEffect(() => {
    if (!prefs.autoCheckUpdates) return;

    const checkForUpdate = async () => {
      let update;
      try {
        update = await check();
      } catch {
        // Offline, endpoint unreachable, or browser debug mode — try again
        // next interval.
        return;
      }
      if (!update) return;
      updateRef.current = update;
      setAvailableVersion(update.version);
      if (update.version === notifiedVersion.current) return;
      notifiedVersion.current = update.version;

      toast(`BranchLab ${update.version} is available`, {
        id: "app-update",
        description: "A new version is ready to install.",
        duration: Infinity,
        action: { label: "Update & restart", onClick: () => void installUpdate() },
      });
    };

    void checkForUpdate();
    const interval = setInterval(
      () => void checkForUpdate(),
      RECHECK_INTERVAL_MS,
    );
    return () => clearInterval(interval);
  }, [prefs.autoCheckUpdates, installUpdate]);

  return (
    <UpdateCtx.Provider value={{ availableVersion, installing, installUpdate }}>
      {children}
    </UpdateCtx.Provider>
  );
}

export function useAppUpdate() {
  return useContext(UpdateCtx);
}
