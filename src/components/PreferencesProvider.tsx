import { createContext, useCallback, useContext, useState } from "react";
import {
  DEFAULTS,
  migrate,
  type LegacyPreferences,
  type Preferences,
  type WorkspacePreferences,
} from "@/lib/prefs";

export type { Preferences, WorkspacePreferences };

const STORAGE_KEY = "branchlab.prefs";

interface PrefsCtxValue {
  prefs: Preferences;
  setPref: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  setWorkspacePref: (
    workspaceId: string,
    update:
      | Partial<WorkspacePreferences>
      | ((prev: WorkspacePreferences) => Partial<WorkspacePreferences>),
  ) => void;
}

const PrefsCtx = createContext<PrefsCtxValue>({
  prefs: DEFAULTS,
  setPref: () => {},
  setWorkspacePref: () => {},
});

function load(): Preferences {
  try {
    const raw = JSON.parse(
      localStorage.getItem(STORAGE_KEY) || "{}",
    ) as LegacyPreferences;
    return migrate(raw, window.innerWidth);
  } catch {
    return DEFAULTS;
  }
}

export function PreferencesProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [prefs, setPrefs] = useState<Preferences>(load);

  const setPref = useCallback<PrefsCtxValue["setPref"]>((key, value) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const setWorkspacePref = useCallback<PrefsCtxValue["setWorkspacePref"]>(
    (workspaceId, update) => {
      setPrefs((prev) => {
        const current = prev.workspace[workspaceId] ?? {};
        const partial = typeof update === "function" ? update(current) : update;
        const next: Preferences = {
          ...prev,
          workspace: {
            ...prev.workspace,
            [workspaceId]: { ...current, ...partial },
          },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    },
    [],
  );

  return (
    <PrefsCtx.Provider value={{ prefs, setPref, setWorkspacePref }}>
      {children}
    </PrefsCtx.Provider>
  );
}

export function usePreferences() {
  return useContext(PrefsCtx);
}

// macOS-only: these are application names handed to the opener plugin's
// openPath (macOS `open -a`). Cross-platform support will need a different
// integration model (e.g. exec paths or freedesktop xdg-open).
export const TERMINAL_APPS = [
  "Terminal",
  "iTerm",
  "Warp",
  "Ghostty",
  "Alacritty",
  "kitty",
];
export const EDITOR_APPS = [
  "Visual Studio Code",
  "Cursor",
  "Zed",
  "Sublime Text",
  "IntelliJ IDEA",
  "WebStorm",
  "PhpStorm",
];
