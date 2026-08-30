import { describe, expect, it } from "vitest";
import {
  back,
  closeSession,
  forward,
  INITIAL_HISTORY,
  push,
  replace,
  routePath,
  sameScreen,
  type HistoryState,
  type RouterState,
} from "./router";

// ── helpers mirroring the hook's navigation callbacks ─────────────────────

const home = (h: HistoryState) =>
  push(h, (s) => ({ ...s, view: "home", settingsTab: null }));
const myWork = (h: HistoryState) =>
  push(h, (s) => ({ ...s, view: "my-work", settingsTab: null }));
const openSession = (h: HistoryState, id: string) =>
  push(h, (s) => ({
    ...s,
    view: "session",
    selectedId: id,
    settingsTab: null,
  }));
const openSettings = (h: HistoryState, tab: "general" | "models" = "general") =>
  push(h, (s) => ({ ...s, settingsTab: tab }));

/** The screens back() would visit, oldest → newest, plus the current one. */
const trail = (h: HistoryState) =>
  [...h.past, h.present].map((s) =>
    s.view === "session" ? `session:${s.selectedId}` : routePath(s),
  );

describe("routePath", () => {
  it("is coarse: no workspace id, settings tracks only the tab", () => {
    expect(
      routePath({ view: "home", selectedId: null, settingsTab: null }),
    ).toBe("/home");
    expect(
      routePath({ view: "my-work", selectedId: null, settingsTab: null }),
    ).toBe("/my-work");
    expect(
      routePath({ view: "session", selectedId: "w1", settingsTab: null }),
    ).toBe("/session");
    expect(
      routePath({ view: "session", selectedId: "w2", settingsTab: null }),
    ).toBe("/session");
    // The settings overlay wins over whatever is behind it.
    expect(
      routePath({ view: "session", selectedId: "w1", settingsTab: "models" }),
    ).toBe("/settings/models");
  });
});

describe("sameScreen", () => {
  const s = (over: Partial<RouterState> = {}): RouterState => ({
    view: "home",
    selectedId: null,
    settingsTab: null,
    ...over,
  });

  it("ignores selectedId unless a session is on screen", () => {
    expect(sameScreen(s({ selectedId: "w1" }), s({ selectedId: "w2" }))).toBe(
      true,
    );
    expect(
      sameScreen(
        s({ view: "session", selectedId: "w1" }),
        s({ view: "session", selectedId: "w2" }),
      ),
    ).toBe(false);
  });

  it("separates views and settings tabs", () => {
    expect(sameScreen(s(), s({ view: "my-work" }))).toBe(false);
    expect(
      sameScreen(s({ settingsTab: "general" }), s({ settingsTab: "models" })),
    ).toBe(false);
    expect(
      sameScreen(s({ settingsTab: "general" }), s({ settingsTab: "general" })),
    ).toBe(true);
  });
});

describe("push", () => {
  it("stacks distinct screens and clears the forward stack", () => {
    let h = myWork(INITIAL_HISTORY);
    h = openSession(h, "w1");
    expect(trail(h)).toEqual(["/home", "/my-work", "session:w1"]);
    expect(h.future).toEqual([]);

    h = back(h);
    expect(h.future).toHaveLength(1);
    h = openSettings(h);
    expect(h.future).toEqual([]);
  });

  it("dedupes a push onto the same screen — back is never a no-op", () => {
    let h = myWork(INITIAL_HISTORY);
    h = myWork(h);
    h = myWork(h);
    expect(trail(h)).toEqual(["/home", "/my-work"]);
    expect(h.past).toHaveLength(1);
  });

  it("still updates state in place when the push dedupes", () => {
    // Reselecting the sidebar row for a non-session view keeps the selection
    // change without adding an entry.
    const h = push(INITIAL_HISTORY, (s) => ({ ...s, selectedId: "w1" }));
    expect(h.past).toEqual([]);
    expect(h.present.selectedId).toBe("w1");
  });

  it("treats a different session as a different screen", () => {
    let h = openSession(INITIAL_HISTORY, "w1");
    h = openSession(h, "w1"); // reselect: no entry
    expect(h.past).toHaveLength(1);
    h = openSession(h, "w2"); // different session: entry
    expect(trail(h)).toEqual(["/home", "session:w1", "session:w2"]);
  });
});

describe("replace", () => {
  it("changes the screen without touching the stacks", () => {
    const opened = openSettings(INITIAL_HISTORY, "general");
    const h = replace(opened, (s) =>
      s.settingsTab ? { ...s, settingsTab: "models" } : s,
    );
    expect(h.present.settingsTab).toBe("models");
    expect(h.past).toEqual(opened.past);
    expect(h.future).toEqual(opened.future);
    // One settings visit = one history entry: back leaves settings entirely.
    expect(back(h).present.settingsTab).toBeNull();
  });

  it("is a no-op when settings is closed", () => {
    const h = replace(INITIAL_HISTORY, (s) =>
      s.settingsTab ? { ...s, settingsTab: "models" } : s,
    );
    expect(h.present).toEqual(INITIAL_HISTORY.present);
  });
});

describe("back / forward", () => {
  it("walks the stacks and is a no-op at the ends", () => {
    expect(back(INITIAL_HISTORY)).toBe(INITIAL_HISTORY);
    expect(forward(INITIAL_HISTORY)).toBe(INITIAL_HISTORY);

    let h = myWork(INITIAL_HISTORY);
    h = openSession(h, "w1");
    h = back(h);
    expect(routePath(h.present)).toBe("/my-work");
    h = back(h);
    expect(routePath(h.present)).toBe("/home");
    expect(back(h)).toBe(h);

    h = forward(h);
    expect(routePath(h.present)).toBe("/my-work");
    h = forward(h);
    expect(h.present.selectedId).toBe("w1");
    expect(forward(h)).toBe(h);
  });

  it("round-trips back-then-forward to the same history", () => {
    const h = openSession(myWork(INITIAL_HISTORY), "w1");
    expect(forward(back(h))).toEqual(h);
  });
});

describe("closeSession", () => {
  it("leaves the dead session's screen for home", () => {
    const h = closeSession(openSession(INITIAL_HISTORY, "w1"), "w1");
    expect(h.present.view).toBe("home");
    expect(h.present.selectedId).toBeNull();
  });

  it("drops the selection but keeps the view when elsewhere", () => {
    // Session opened, then navigated away — the sidebar still highlights it.
    let h = openSession(INITIAL_HISTORY, "w1");
    h = myWork(h);
    expect(h.present.selectedId).toBe("w1");
    h = closeSession(h, "w1");
    expect(h.present.view).toBe("my-work");
    expect(h.present.selectedId).toBeNull();
  });

  it("leaves an unrelated workspace alone", () => {
    const opened = openSession(INITIAL_HISTORY, "w1");
    expect(closeSession(opened, "w2")).toEqual(opened);
  });

  // The invariant that matters.
  it("back can never land on a closed session", () => {
    let h = openSession(INITIAL_HISTORY, "w1");
    h = myWork(h);
    h = openSession(h, "w2");
    h = openSession(h, "w1");
    expect(trail(h)).toEqual([
      "/home",
      "session:w1",
      "/my-work",
      "session:w2",
      "session:w1",
    ]);

    h = closeSession(h, "w1");
    // Walk the whole history in both directions: w1 must never reappear.
    const visited: RouterState[] = [h.present];
    while (h.past.length) {
      h = back(h);
      visited.push(h.present);
    }
    while (h.future.length) {
      h = forward(h);
      visited.push(h.present);
    }
    for (const s of visited)
      expect(s.view === "session" && s.selectedId === "w1").toBe(false);
    expect(h.past.map(routePath)).toEqual(["/home", "/my-work", "/session"]);
  });

  it("KNOWN WART: back can be a visible no-op right after a close", () => {
    // scrub() collapses duplicates it makes adjacent *within* each stack, but
    // `present` is not part of that pass — so home → w1, then closing w1,
    // leaves /home stacked behind a present that just became /home. The first
    // back press then changes nothing on screen. Pinned, not fixed: the
    // documented invariant (never land on a dead session) still holds.
    let h = openSession(INITIAL_HISTORY, "w1");
    h = closeSession(h, "w1");
    expect(routePath(h.present)).toBe("/home");
    expect(h.past.map(routePath)).toEqual(["/home"]);
    expect(routePath(back(h).present)).toBe("/home");
  });

  it("prunes the forward stack too", () => {
    let h = openSession(INITIAL_HISTORY, "w1");
    h = myWork(h);
    h = back(h); // w1 is now in `future`
    expect(h.future.some((s) => s.selectedId === "w1")).toBe(true);
    h = closeSession(h, "w1");
    expect(h.future.some((s) => s.view === "session")).toBe(false);
  });

  it("collapses duplicates the pruning makes adjacent", () => {
    // home → w1 → home: removing w1 would leave two identical /home entries,
    // making one back press look broken.
    let h = openSession(INITIAL_HISTORY, "w1");
    h = home(h);
    h = myWork(h);
    expect(trail(h)).toEqual(["/home", "session:w1", "/home", "/my-work"]);

    h = closeSession(h, "w1");
    expect(trail(h)).toEqual(["/home", "/my-work"]);
    expect(routePath(back(h).present)).toBe("/home");
  });

  it("prunes every occurrence of a session opened many times", () => {
    let h = openSession(INITIAL_HISTORY, "w1");
    h = myWork(h);
    h = openSession(h, "w1");
    h = home(h);
    h = openSession(h, "w1");
    h = closeSession(h, "w1");
    expect(trail(h).some((p) => p.startsWith("session:"))).toBe(false);
  });
});
