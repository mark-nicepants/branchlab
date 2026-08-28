// Centralized navigation state — the app's "router". Every screen change
// (nav views, opening a session, the settings overlay) flows through here as
// one atomic state object, and each distinct path is reported to backend
// telemetry as a pageview, website-style. Paths are deliberately coarse:
// "/session" never includes a workspace id, and settings tracks only the tab.
//
// Browser-style history: every push-navigation stores the previous state on a
// `past` stack and clears `future`; back()/forward() walk the stacks (the
// back/forward chevrons + ⌘[ / ⌘]). Settings tab switches REPLACE (one
// settings visit = one entry); a deleted workspace is pruned from both stacks
// so back can never land on a dead session.
import { useCallback, useEffect, useRef, useState } from "react";
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

interface HistoryState {
  past: RouterState[];
  present: RouterState;
  future: RouterState[];
}

function routePath(s: RouterState): string {
  if (s.settingsTab) return `/settings/${s.settingsTab}`;
  return s.view === "session" ? "/session" : `/${s.view}`;
}

/** Two states land on the same screen — pushing both would make back a no-op. */
function sameScreen(a: RouterState, b: RouterState): boolean {
  return (
    a.view === b.view &&
    a.settingsTab === b.settingsTab &&
    // selectedId only distinguishes screens while a session is on screen.
    (a.view !== "session" || a.selectedId === b.selectedId)
  );
}

export function useAppRouter() {
  const [state, setState] = useState<HistoryState>({
    past: [],
    present: { view: "home", selectedId: null, settingsTab: null },
    future: [],
  });

  /** Push-navigate: stack the current screen, clear the forward stack. */
  const push = useCallback(
    (next: (s: RouterState) => RouterState) =>
      setState((h) => {
        const target = next(h.present);
        if (sameScreen(h.present, target))
          return { ...h, present: target }; // e.g. reselect without stacking
        return { past: [...h.past, h.present], present: target, future: [] };
      }),
    [],
  );
  /** Replace in place — no history entry (tab switches, dead-session fixups). */
  const replace = useCallback(
    (next: (s: RouterState) => RouterState) =>
      setState((h) => ({ ...h, present: next(h.present) })),
    [],
  );

  const path = routePath(state.present);
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
      setState((h) => {
        const dead = (s: RouterState) =>
          s.view === "session" && s.selectedId === workspaceId;
        const scrub = (list: RouterState[]) => {
          const kept = list.filter((s) => !dead(s));
          // Collapse duplicates the removal may have made adjacent.
          return kept.filter((s, i) => i === 0 || !sameScreen(kept[i - 1], s));
        };
        const present =
          h.present.selectedId === workspaceId
            ? {
                ...h.present,
                selectedId: null,
                view: h.present.view === "session" ? "home" : h.present.view,
              }
            : h.present;
        return { past: scrub(h.past), present, future: scrub(h.future) };
      }),
    [],
  );
  const openSettings = useCallback(
    (tab: SettingsTab = "general") =>
      push((s) => ({ ...s, settingsTab: tab })),
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

  const back = useCallback(
    () =>
      setState((h) => {
        const prev = h.past[h.past.length - 1];
        if (!prev) return h;
        return {
          past: h.past.slice(0, -1),
          present: prev,
          future: [h.present, ...h.future],
        };
      }),
    [],
  );
  const forward = useCallback(
    () =>
      setState((h) => {
        const [next, ...rest] = h.future;
        if (!next) return h;
        return { past: [...h.past, h.present], present: next, future: rest };
      }),
    [],
  );

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
