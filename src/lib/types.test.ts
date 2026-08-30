import { describe, expect, it } from "vitest";
import {
  formatEstimate,
  nearestTshirt,
  workspaceLabel,
  type Workspace,
} from "./types";

function ws(overrides: Partial<Workspace>): Workspace {
  return {
    id: "w1",
    project_id: "p1",
    kind: "Worktree",
    path: "/tmp/w1",
    branch: null,
    name: null,
    base_branch: null,
    init_prompt: null,
    autofix_mode: "off",
    model: null,
    effort: null,
    pr_number: null,
    pr_is_fork: false,
    pr: null,
    setup: "ready",
    ...overrides,
  };
}

describe("workspaceLabel", () => {
  it("prefers the explicit name", () => {
    expect(
      workspaceLabel(ws({ name: "Auth refactor", branch: "feat/auth" })),
    ).toBe("Auth refactor");
  });

  it("falls back to the branch when there is no name", () => {
    expect(workspaceLabel(ws({ name: null, branch: "feat/auth" }))).toBe(
      "feat/auth",
    );
  });

  it("falls back to a default when neither is set", () => {
    expect(workspaceLabel(ws({ name: null, branch: null }))).toBe("workspace");
  });
});

describe("formatEstimate", () => {
  it("shows bare numbers for points and hours (unit-silent)", () => {
    expect(formatEstimate(3, "points")).toBe("3");
    expect(formatEstimate(1.5, "hours")).toBe("1.5");
  });

  it("shows size letters for t-shirt, snapping non-exact values", () => {
    expect(formatEstimate(3, "tshirt")).toBe("M");
    expect(formatEstimate(8, "tshirt")).toBe("XL");
    expect(formatEstimate(6, "tshirt")).toBe("L"); // 6 → nearest is 5
    expect(formatEstimate(100, "tshirt")).toBe("XL");
    expect(formatEstimate(0, "tshirt")).toBe("XS");
  });

  it("rounds ties up to the larger size", () => {
    expect(nearestTshirt(4).label).toBe("L"); // 4 is between M(3) and L(5)
  });
});
