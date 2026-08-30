import { describe, expect, it } from "vitest";
import { DEFAULTS, migrate, type LegacyPreferences } from "./prefs";

describe("migrate — defaults", () => {
  it("fills an empty store with the defaults", () => {
    expect(migrate({})).toEqual(DEFAULTS);
  });

  it("keeps stored values and fills only the gaps", () => {
    const stored: LegacyPreferences = {
      terminalApp: "Ghostty",
      disabledModels: ["a/b"],
    };
    expect(migrate(stored)).toEqual({
      ...DEFAULTS,
      terminalApp: "Ghostty",
      disabledModels: ["a/b"],
    });
  });

  it("preserves falsy stored values instead of re-defaulting them", () => {
    expect(migrate({ autoCheckUpdates: false }).autoCheckUpdates).toBe(false);
    expect(migrate({ terminalApp: "" }).terminalApp).toBe("");
  });

  it("adds keys introduced after the store was written", () => {
    // An old store predating changesPanelOpen / modelCatalog.
    const old = { autoCheckUpdates: true, terminalApp: "iTerm" };
    const p = migrate(old);
    expect(p.changesPanelOpen).toBe(false);
    expect(p.modelCatalog).toEqual([]);
    expect(p.workspace).toEqual({});
  });
});

describe("migrate — legacy percentage panel width", () => {
  it("converts a percentage against the viewport", () => {
    expect(
      migrate({ changesPanelWidthPct: 40 }, 2000).changesPanelWidthPx,
    ).toBe(800);
  });

  it("falls back to 1280 for a zero/absent viewport", () => {
    expect(migrate({ changesPanelWidthPct: 50 }, 0).changesPanelWidthPx).toBe(
      640,
    );
    expect(migrate({ changesPanelWidthPct: 50 }).changesPanelWidthPx).toBe(640);
  });

  it("clamps a converted width into the resizer's range", () => {
    expect(migrate({ changesPanelWidthPct: 5 }, 2000).changesPanelWidthPx).toBe(
      320,
    );
    expect(
      migrate({ changesPanelWidthPct: 95 }, 4000).changesPanelWidthPx,
    ).toBe(1200);
  });

  it("prefers an already-migrated pixel width and ignores the legacy field", () => {
    const p = migrate(
      { changesPanelWidthPx: 500, changesPanelWidthPct: 90 },
      2000,
    );
    expect(p.changesPanelWidthPx).toBe(500);
  });

  it("is a no-op for an already-migrated store", () => {
    const migrated = migrate({}, 1280);
    expect(migrate(migrated, 1280)).toEqual(migrated);
  });

  it("clamps a hand-edited or stale pixel width", () => {
    expect(migrate({ changesPanelWidthPx: 10 }).changesPanelWidthPx).toBe(320);
    expect(migrate({ changesPanelWidthPx: 99999 }).changesPanelWidthPx).toBe(
      1200,
    );
  });
});
