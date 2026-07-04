// Centralized navigation state — the app's "router". Every screen change
// (nav views, opening a session, the settings overlay) flows through here as
// one atomic state object, and each distinct path is reported to backend
// telemetry as a pageview, website-style. Paths are deliberately coarse:
// "/session" never includes a workspace id, and settings tracks only the tab.
import { useCallback, useEffect, useState } from "react";
import type { SettingsTab } from "@/components/settings/SettingsScreen";
import type { NavView } from "@/components/shell/SessionsSidebar";
// Relative specifier so the browser harness's mock alias applies (see
// vite.config.ts — aliases match exact import forms).
import { telemetryPageview } from "../lib/api";

export type AppView = NavView | "session";

interface RouterState {
  view: AppView;
  /** Selected workspace; retained while navigating away so the sidebar can
   *  keep highlighting it, like before. */
  selectedId: string | null;
  /** Settings overlay tab, or null when closed. Modeled as a route overlay so
   *  opening settings tracks like a page change. */
  settingsTab: SettingsTab | null;
}

export function routePath(s: RouterState): string {
  if (s.settingsTab) return `/settings/${s.settingsTab}`;
  return s.view === "session" ? "/session" : `/${s.view}`;
}

export function useAppRouter() {
  const [state, setState] = useState<RouterState>({
    view: "home",
    selectedId: null,
    settingsTab: null,
  });

  const path = routePath(state);
  useEffect(() => {
    telemetryPageview(path).catch(() => {}); // telemetry never breaks the UI
  }, [path]);

  const navigate = useCallback(
    (view: NavView) => setState((s) => ({ ...s, view })),
    [],
  );
  const openSession = useCallback(
    (workspaceId: string) =>
      setState((s) => ({ ...s, view: "session", selectedId: workspaceId })),
    [],
  );
  /** A workspace disappeared (deleted / quick chat closed): drop the selection
   *  and fall back to home if it was on screen. */
  const closeSession = useCallback(
    (workspaceId: string) =>
      setState((s) =>
        s.selectedId === workspaceId
          ? {
              ...s,
              selectedId: null,
              view: s.view === "session" ? "home" : s.view,
            }
          : s,
      ),
    [],
  );
  const openSettings = useCallback(
    (tab: SettingsTab = "general") =>
      setState((s) => ({ ...s, settingsTab: tab })),
    [],
  );
  const closeSettings = useCallback(
    () => setState((s) => ({ ...s, settingsTab: null })),
    [],
  );
  /** Settings dialog reports its internal tab switches here so they track. */
  const settingsTabChanged = useCallback(
    (tab: SettingsTab) =>
      setState((s) => (s.settingsTab ? { ...s, settingsTab: tab } : s)),
    [],
  );

  return {
    view: state.view,
    selectedId: state.selectedId,
    settingsTab: state.settingsTab,
    navigate,
    openSession,
    closeSession,
    openSettings,
    closeSettings,
    settingsTabChanged,
  };
}
