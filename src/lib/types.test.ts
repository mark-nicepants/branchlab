import { describe, expect, it } from "vitest";
import { workspaceLabel, type Workspace } from "./types";

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
