// The app's navigation state machine — browser-style history, as pure
// functions. `useAppRouter` is the React wrapper; everything that decides what
// `back` lands on lives here.
//
// Every push-navigation stacks the previous screen on `past` and clears
// `future`; back/forward walk the stacks. Two rules keep the chevrons honest:
//   - Pushing the screen you're already on REPLACES instead of stacking —
//     otherwise back would be a visible no-op.
//   - A workspace that disappears (deleted / quick chat closed) is pruned from
//     both stacks, so back can never land on a dead session.

import type { SettingsTab } from "@/components/settings/SettingsScreen";
import type { NavView } from "@/components/shell/SessionsSidebar";

export type AppView = NavView | "session";

export interface RouterState {
  view: AppView;
  /** Selected workspace; retained while navigating away so the sidebar can
   *  keep highlighting it, like before. */
  selectedId: string | null;
  /** Settings overlay tab, or null when closed. Modeled as a route overlay so
   *  opening settings tracks like a page change. */
  settingsTab: SettingsTab | null;
}

export interface HistoryState {
  past: RouterState[];
  present: RouterState;
  future: RouterState[];
}

export const INITIAL_HISTORY: HistoryState = {
  past: [],
  present: { view: "home", selectedId: null, settingsTab: null },
  future: [],
};

/** The telemetry pageview path. Deliberately coarse: "/session" never includes
 *  a workspace id, and settings tracks only the tab. */
export function routePath(s: RouterState): string {
  if (s.settingsTab) return `/settings/${s.settingsTab}`;
  return s.view === "session" ? "/session" : `/${s.view}`;
}

/** Two states land on the same screen — pushing both would make back a no-op. */
export function sameScreen(a: RouterState, b: RouterState): boolean {
  return (
    a.view === b.view &&
    a.settingsTab === b.settingsTab &&
    // selectedId only distinguishes screens while a session is on screen.
    (a.view !== "session" || a.selectedId === b.selectedId)
  );
}

/** Push-navigate: stack the current screen, clear the forward stack. */
export function push(
  h: HistoryState,
  next: (s: RouterState) => RouterState,
): HistoryState {
  const target = next(h.present);
  // e.g. reselecting the open session: update in place without stacking.
  if (sameScreen(h.present, target)) return { ...h, present: target };
  return { past: [...h.past, h.present], present: target, future: [] };
}

/** Replace in place — no history entry (tab switches, dead-session fixups). */
export function replace(
  h: HistoryState,
  next: (s: RouterState) => RouterState,
): HistoryState {
  return { ...h, present: next(h.present) };
}

export function back(h: HistoryState): HistoryState {
  const prev = h.past[h.past.length - 1];
  if (!prev) return h;
  return {
    past: h.past.slice(0, -1),
    present: prev,
    future: [h.present, ...h.future],
  };
}

export function forward(h: HistoryState): HistoryState {
  const [next, ...rest] = h.future;
  if (!next) return h;
  return { past: [...h.past, h.present], present: next, future: rest };
}

/** A workspace disappeared: drop the selection, fall back to home if it was on
 *  screen, and prune it from history so back/forward can never land on it. */
export function closeSession(
  h: HistoryState,
  workspaceId: string,
): HistoryState {
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
}
