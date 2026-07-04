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
  /** Poll the release endpoint for updates (launch + every few hours). */
  autoCheckUpdates: boolean;
  /** macOS app name used for "Open in terminal" (open -a). */
  terminalApp: string;
  /** macOS app name used for "Open in IDE" (open -a). */
  editorApp: string;
  /** Model keys (`providerID/modelID`) hidden from the model selector. */
  disabledModels: string[];
  /** Cached model catalog (value/name/group), captured from the last session's
   *  ACP-advertised model option so the global Models settings page can render
   *  the list without an open session. */
  modelCatalog: { value: string; name: string; group?: string | null }[];
  /** Per-workspace preferences (model, variant, session, draft input, …). */
  workspace: Record<string, WorkspacePreferences>;
  /** Collapsed state of project stats panels in the sidebar (project id → boolean). */
  collapsedProjects: Record<string, boolean>;
  /** Vertical spacing density for chat messages. */
  chatDensity: ChatDensity;
  /** Width of the session changes panel in pixels (shared across sessions).
   *  Pixel-based so window resizes keep the panel stable and only the chat
   *  column flexes. */
  changesPanelWidthPx: number;
  /** Whether the session changes panel is open (shared across sessions). */
  changesPanelOpen: boolean;
}

const DEFAULTS: Preferences = {
  autoCheckUpdates: true,
  terminalApp: "Terminal",
  editorApp: "Visual Studio Code",
  disabledModels: [],
  modelCatalog: [],
  workspace: {},
  collapsedProjects: {},
  chatDensity: "loose",
  changesPanelWidthPx: 420,
  changesPanelOpen: false,
};

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

type LegacyPreferences = Partial<
  Preferences & {
    workspaceModels: Record<string, string>;
    workspaceVariants: Record<string, string>;
    workspaceSessions: Record<string, string>;
    /** Pre-pixel panel width, as a % of the session body. */
    changesPanelWidthPct: number;
  }
>;

/** Migrate old flat per-workspace keys into the grouped `workspace` object. */
function migrate(raw: LegacyPreferences): Preferences {
  const workspace: Record<string, WorkspacePreferences> = {
    ...(raw.workspace ?? {}),
  };
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
  // Panel width moved from % of the body to fixed pixels — approximate the old
  // percentage against the current window so the panel keeps its familiar size.
  let changesPanelWidthPx = raw.changesPanelWidthPx;
  if (changesPanelWidthPx == null && raw.changesPanelWidthPct != null) {
    changesPanelWidthPx = Math.round(
      (raw.changesPanelWidthPct / 100) * (window.innerWidth || 1280),
    );
  }
  changesPanelWidthPx = Math.min(
    1200,
    Math.max(320, changesPanelWidthPx ?? DEFAULTS.changesPanelWidthPx),
  );
  return { ...DEFAULTS, ...raw, workspace, changesPanelWidthPx };
}

function load(): Preferences {
  try {
    const raw = JSON.parse(
      localStorage.getItem(STORAGE_KEY) || "{}",
    ) as LegacyPreferences;
    return migrate(raw);
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

// macOS-only: these are application names passed to `open -a` in
// commands.rs::open_external. Cross-platform support will need a different
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
