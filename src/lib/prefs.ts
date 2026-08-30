// Persisted UI preferences: the shape, the defaults, and the migration from
// older stored shapes. Pure — the provider owns localStorage and the window.

/** Preferences stored per workspace. */
export interface WorkspacePreferences {
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
  /** Per-workspace preferences (draft input). */
  workspace: Record<string, WorkspacePreferences>;
  /** Collapsed state of project stats panels in the sidebar (project id → boolean). */
  collapsedProjects: Record<string, boolean>;
  /** Width of the session changes panel in pixels (shared across sessions).
   *  Pixel-based so window resizes keep the panel stable and only the chat
   *  column flexes. */
  changesPanelWidthPx: number;
  /** Whether the session changes panel is open (shared across sessions). */
  changesPanelOpen: boolean;
}

export const DEFAULTS: Preferences = {
  autoCheckUpdates: true,
  terminalApp: "Terminal",
  editorApp: "Visual Studio Code",
  disabledModels: [],
  modelCatalog: [],
  workspace: {},
  collapsedProjects: {},
  changesPanelWidthPx: 420,
  changesPanelOpen: false,
};

export type LegacyPreferences = Partial<
  Preferences & {
    /** Pre-pixel panel width, as a % of the session body. */
    changesPanelWidthPct: number;
  }
>;

/** Panel width is clamped to what the resizer allows, so a hand-edited or
 *  migrated value can't leave the panel unusable. */
const MIN_PANEL_PX = 320;
const MAX_PANEL_PX = 1200;

/** Normalize stored preferences (incl. legacy shapes) into `Preferences`.
 *  `viewportWidth` converts the pre-pixel percentage width; the provider
 *  passes `window.innerWidth`. */
export function migrate(
  raw: LegacyPreferences,
  viewportWidth = 1280,
): Preferences {
  // Panel width moved from % of the body to fixed pixels — approximate the old
  // percentage against the current window so the panel keeps its familiar size.
  let changesPanelWidthPx = raw.changesPanelWidthPx;
  if (changesPanelWidthPx == null && raw.changesPanelWidthPct != null) {
    changesPanelWidthPx = Math.round(
      (raw.changesPanelWidthPct / 100) * (viewportWidth || 1280),
    );
  }
  changesPanelWidthPx = Math.min(
    MAX_PANEL_PX,
    Math.max(MIN_PANEL_PX, changesPanelWidthPx ?? DEFAULTS.changesPanelWidthPx),
  );
  return { ...DEFAULTS, ...raw, changesPanelWidthPx };
}
