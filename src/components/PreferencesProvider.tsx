import { createContext, useCallback, useContext, useState } from "react";

const STORAGE_KEY = "branchlab.prefs";

export type ChatDensity = "tight" | "loose" | "roomy";

/** Preferences stored per workspace. */
export interface WorkspacePreferences {
  /** Last selected model key (`providerID/modelID`). */
  modelKey?: string;
  /** Reasoning-effort variant; empty string means the model's default. */
  variant?: string;
  /** OpenCode session id reused for this workspace. */
  sessionId?: string;
  /** Draft text in the composer input box. */
  inputText?: string;
}

export interface Preferences {
  /** macOS app name used for "Open in terminal" (open -a). */
  terminalApp: string;
  /** macOS app name used for "Open in IDE" (open -a). */
  editorApp: string;
  /** Model keys (`providerID/modelID`) hidden from the model selector. */
  disabledModels: string[];
  /** Per-workspace preferences (model, variant, session, draft input, …). */
  workspace: Record<string, WorkspacePreferences>;
  /** Collapsed state of project stats panels in the sidebar (project id → boolean). */
  collapsedProjects: Record<string, boolean>;
  /** Vertical spacing density for chat messages. */
  chatDensity: ChatDensity;
}

const DEFAULTS: Preferences = {
  terminalApp: "Terminal",
  editorApp: "Visual Studio Code",
  disabledModels: [],
  workspace: {},
  collapsedProjects: {},
  chatDensity: "loose",
};

interface PrefsCtxValue {
  prefs: Preferences;
  setPref: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  setWorkspacePref: (
    workspaceId: string,
    update: Partial<WorkspacePreferences> | ((prev: WorkspacePreferences) => Partial<WorkspacePreferences>),
  ) => void;
}

const PrefsCtx = createContext<PrefsCtxValue>({
  prefs: DEFAULTS,
  setPref: () => {},
  setWorkspacePref: () => {},
});

type LegacyPreferences = Partial<
  Preferences & {
    workspaceModels: Record<string, string>;
    workspaceVariants: Record<string, string>;
    workspaceSessions: Record<string, string>;
  }
>;

/** Migrate old flat per-workspace keys into the grouped `workspace` object. */
function migrate(raw: LegacyPreferences): Preferences {
  const workspace: Record<string, WorkspacePreferences> = { ...(raw.workspace ?? {}) };
  if (raw.workspaceModels) {
    for (const [id, key] of Object.entries(raw.workspaceModels)) {
      workspace[id] = { ...workspace[id], modelKey: key };
    }
  }
  if (raw.workspaceVariants) {
    for (const [id, variant] of Object.entries(raw.workspaceVariants)) {
      workspace[id] = { ...workspace[id], variant };
    }
  }
  if (raw.workspaceSessions) {
    for (const [id, sessionId] of Object.entries(raw.workspaceSessions)) {
      workspace[id] = { ...workspace[id], sessionId };
    }
  }
  return { ...DEFAULTS, ...raw, workspace };
}

function load(): Preferences {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as LegacyPreferences;
    return migrate(raw);
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

  const setWorkspacePref = useCallback<PrefsCtxValue["setWorkspacePref"]>((workspaceId, update) => {
    setPrefs((prev) => {
      const current = prev.workspace[workspaceId] ?? {};
      const partial = typeof update === "function" ? update(current) : update;
      const next: Preferences = {
        ...prev,
        workspace: { ...prev.workspace, [workspaceId]: { ...current, ...partial } },
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return <PrefsCtx.Provider value={{ prefs, setPref, setWorkspacePref }}>{children}</PrefsCtx.Provider>;
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
