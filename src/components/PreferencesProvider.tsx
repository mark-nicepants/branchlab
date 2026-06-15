import { createContext, useCallback, useContext, useState } from "react";

const STORAGE_KEY = "branchlab.prefs";

export interface Preferences {
  /** macOS app name used for "Open in terminal" (open -a). */
  terminalApp: string;
  /** macOS app name used for "Open in IDE" (open -a). */
  editorApp: string;
}

const DEFAULTS: Preferences = {
  terminalApp: "Terminal",
  editorApp: "Visual Studio Code",
};

interface PrefsCtxValue {
  prefs: Preferences;
  setPref: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
}

const PrefsCtx = createContext<PrefsCtxValue>({
  prefs: DEFAULTS,
  setPref: () => {},
});

function load(): Preferences {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(load);

  const setPref = useCallback<PrefsCtxValue["setPref"]>((key, value) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return <PrefsCtx.Provider value={{ prefs, setPref }}>{children}</PrefsCtx.Provider>;
}

export function usePreferences() {
  return useContext(PrefsCtx);
}

/** Curated app options for the "Open in…" settings (macOS app names). */
export const TERMINAL_APPS = ["Terminal", "iTerm", "Warp", "Ghostty", "Alacritty", "kitty"];
export const EDITOR_APPS = [
  "Visual Studio Code",
  "Cursor",
  "Zed",
  "Sublime Text",
  "IntelliJ IDEA",
  "WebStorm",
  "PhpStorm",
];
