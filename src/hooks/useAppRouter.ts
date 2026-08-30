// Centralized navigation state — the app's "router". Every screen change
// (nav views, opening a session, the settings overlay) flows through here as
// one atomic state object, and each distinct path is reported to backend
// telemetry as a pageview, website-style.
//
// The history state machine itself (push / sameScreen dedupe / back / forward
// / closeSession pruning) lives in `lib/router.ts` as pure functions; this
// hook is the React binding: state, the pageview effect, and the ⌘[ / ⌘] keys.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsTab } from "@/components/settings/SettingsScreen";
import type { NavView } from "@/components/shell/SessionsSidebar";
import * as router from "@/lib/router";
// Relative specifier so the browser harness's mock alias applies (see
// vite.config.ts — aliases match exact import forms).
import { telemetryPageview } from "../lib/api";

export function useAppRouter() {
  const [state, setState] = useState(router.INITIAL_HISTORY);

  /** Push-navigate: stack the current screen, clear the forward stack. */
  const push = useCallback(
    (next: (s: router.RouterState) => router.RouterState) =>
      setState((h) => router.push(h, next)),
    [],
  );
  /** Replace in place — no history entry (tab switches, dead-session fixups). */
  const replace = useCallback(
    (next: (s: router.RouterState) => router.RouterState) =>
      setState((h) => router.replace(h, next)),
    [],
  );

  const path = router.routePath(state.present);
  useEffect(() => {
    telemetryPageview(path).catch(() => {}); // telemetry never breaks the UI
  }, [path]);

  const navigate = useCallback(
    (view: NavView) => push((s) => ({ ...s, view, settingsTab: null })),
    [push],
  );
  const openSession = useCallback(
    (workspaceId: string) =>
      push((s) => ({
        ...s,
        view: "session",
        selectedId: workspaceId,
        settingsTab: null,
      })),
    [push],
  );
  /** A workspace disappeared (deleted / quick chat closed): drop the selection,
   *  fall back to home if it was on screen, and prune it from history so
   *  back/forward can never land on the dead session. */
  const closeSession = useCallback(
    (workspaceId: string) =>
      setState((h) => router.closeSession(h, workspaceId)),
    [],
  );
  const openSettings = useCallback(
    (tab: SettingsTab = "general") => push((s) => ({ ...s, settingsTab: tab })),
    [push],
  );
  const closeSettings = useCallback(
    () => push((s) => ({ ...s, settingsTab: null })),
    [push],
  );
  /** Settings dialog reports its internal tab switches here so they track.
   *  Replaces (one settings visit = one history entry). */
  const settingsTabChanged = useCallback(
    (tab: SettingsTab) =>
      replace((s) => (s.settingsTab ? { ...s, settingsTab: tab } : s)),
    [replace],
  );

  const back = useCallback(() => setState(router.back), []);
  const forward = useCallback(() => setState(router.forward), []);

  // ⌘[ / ⌘] — browser-style history keys (global; text fields don't use them).
  const keysRef = useRef({ back, forward });
  keysRef.current = { back, forward };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key === "[") {
        e.preventDefault();
        keysRef.current.back();
      } else if (e.key === "]") {
        e.preventDefault();
        keysRef.current.forward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return {
    view: state.present.view,
    selectedId: state.present.selectedId,
    settingsTab: state.present.settingsTab,
    canGoBack: state.past.length > 0,
    canGoForward: state.future.length > 0,
    back,
    forward,
    navigate,
    openSession,
    closeSession,
    openSettings,
    closeSettings,
    settingsTabChanged,
  };
}
