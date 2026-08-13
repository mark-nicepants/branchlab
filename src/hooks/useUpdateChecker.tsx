// App-update state, shared across the UI. The provider polls the update
// endpoint (on launch, then every few hours — gated on the "Automatically
// check for updates" preference), surfaces a small toast when a new version
// appears, and exposes the pending update so the sidebar can badge the
// settings gear and Settings → General can render an update banner + a
// manual "Check now" with the last-checked time.
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
  /** When the endpoint was last successfully checked (ms epoch), this session. */
  lastCheckedAt: number | null;
  /** True while a check is in flight. */
  checking: boolean;
  /** Manual check (Settings → "Check now"). Toasts the result either way. */
  checkNow: () => Promise<void>;
}

const UpdateCtx = createContext<UpdateCtxValue>({
  availableVersion: null,
  installing: false,
  installUpdate: async () => {},
  lastCheckedAt: null,
  checking: false,
  checkNow: async () => {},
});

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const { prefs } = usePreferences();
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
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

  /** One check. `manual` checks always report their outcome with a toast;
   *  background checks stay silent unless a new version appears. */
  const runCheck = useCallback(
    async (manual: boolean) => {
      setChecking(true);
      let update;
      try {
        update = await check();
      } catch (e) {
        // Offline, endpoint unreachable, or browser debug mode.
        if (manual) {
          toast.error("Could not check for updates", {
            description: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      } finally {
        setChecking(false);
      }
      setLastCheckedAt(Date.now());
      if (!update) {
        if (manual) toast.success("You're on the latest version");
        return;
      }
      updateRef.current = update;
      setAvailableVersion(update.version);
      if (!manual && update.version === notifiedVersion.current) return;
      notifiedVersion.current = update.version;

      toast(`BranchLab ${update.version} is available`, {
        id: "app-update",
        description: "A new version is ready to install.",
        duration: Infinity,
        action: { label: "Update & restart", onClick: () => void installUpdate() },
      });
    },
    [installUpdate],
  );

  const checkNow = useCallback(() => runCheck(true), [runCheck]);

  useEffect(() => {
    if (!prefs.autoCheckUpdates) return;
    void runCheck(false);
    const interval = setInterval(
      () => void runCheck(false),
      RECHECK_INTERVAL_MS,
    );
    return () => clearInterval(interval);
  }, [prefs.autoCheckUpdates, runCheck]);

  return (
    <UpdateCtx.Provider
      value={{
        availableVersion,
        installing,
        installUpdate,
        lastCheckedAt,
        checking,
        checkNow,
      }}
    >
      {children}
    </UpdateCtx.Provider>
  );
}

export function useAppUpdate() {
  return useContext(UpdateCtx);
}
