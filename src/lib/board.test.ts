import { describe, expect, it } from "vitest";
import {
  buildBoardCtx,
  depCandidates,
  deriveState,
  estimateLabel,
  firstUnmetDep,
  positionAtEnd,
  positionBefore,
  roleToState,
} from "./board";
import type { BoardColumn, ColumnRole, Task } from "./types";

let seq = 0;
function task(over: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    number: seq,
    title: `Task ${seq}`,
    description: null,
    projectId: null,
    columnId: "todo",
    position: 1024,
    workspaceId: null,
    parentId: null,
    dependsOn: [],
    estimate: null,
    attachments: [],
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    ...over,
  };
}

function column(id: string, role: ColumnRole): BoardColumn {
  return { id, name: id, role, position: 0, updatedAt: 0, deletedAt: null };
}

/** Positions as the board sees them: ascending, with ids to sort by. */
const at = (id: string, position: number) => task({ id, position });

describe("positionBefore", () => {
  it("appends 1024 past the last card when there is no `next`", () => {
    expect(positionBefore([at("a", 1024), at("b", 2048)], null)).toBe(3072);
  });

  it("returns 1024 for an empty column", () => {
    expect(positionBefore([], null)).toBe(1024);
  });

  it("halves the first position when inserting before the first card", () => {
    const first = at("a", 1024);
    expect(positionBefore([first, at("b", 2048)], first)).toBe(512);
  });

  it("takes the midpoint when inserting between two cards", () => {
    const b = at("b", 2048);
    expect(positionBefore([at("a", 1024), b, at("c", 4096)], b)).toBe(1536);
  });

  it("inserting before the last card uses the gap above it", () => {
    const c = at("c", 4096);
    expect(positionBefore([at("a", 1024), at("b", 2048), c], c)).toBe(3072);
  });

  it("converges (never repeats or inverts) on repeated inserts into one gap", () => {
    // Drag the same card to the same slot over and over: each pass must land
    // strictly between its neighbours, or the board silently reorders.
    let sorted = [at("a", 1024), at("b", 2048)];
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      const b = sorted[sorted.length - 1];
      const p = positionBefore(sorted, b);
      const prev = sorted[sorted.length - 2];
      expect(p).toBeGreaterThan(prev.position);
      expect(p).toBeLessThan(b.position);
      seen.push(p);
      sorted = [...sorted.slice(0, -1), at(`n${i}`, p), b];
    }
    // Strictly decreasing gaps, and no two inserts ever produce the same key.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("ignores cards after `next` when computing the midpoint", () => {
    const a = at("a", 100);
    expect(positionBefore([a, at("b", 200), at("c", 300)], a)).toBe(50);
  });
});

describe("positionAtEnd", () => {
  it("returns 1024 for a column with no cards", () => {
    expect(positionAtEnd([task({ columnId: "other", position: 9000 })], "done"))
      .toBe(1024);
  });

  it("returns 1024 for an empty board", () => {
    expect(positionAtEnd([], "done")).toBe(1024);
  });

  it("only considers cards in the target column", () => {
    const tasks = [
      task({ columnId: "done", position: 2048 }),
      task({ columnId: "todo", position: 9999 }),
      task({ columnId: "done", position: 512 }),
    ];
    expect(positionAtEnd(tasks, "done")).toBe(2048 + 1024);
  });

  it("clamps at 0 so all-negative positions still land above them", () => {
    expect(positionAtEnd([task({ columnId: "done", position: -5 })], "done"))
      .toBe(1024);
  });
});

describe("deriveState", () => {
  it("maps done and review columns straight through", () => {
    expect(deriveState(task(), "done")).toBe("done");
    expect(deriveState(task(), "review")).toBe("review");
  });

  it("splits the active column on whether a session is linked", () => {
    expect(deriveState(task({ workspaceId: "w1" }), "active")).toBe("working");
    expect(deriveState(task({ workspaceId: null }), "active")).toBe("queued");
  });

  it("treats queued and unroled columns as todo", () => {
    expect(deriveState(task(), "queued")).toBe("todo");
    expect(deriveState(task(), "none")).toBe("todo");
  });

  it("ignores the link outside the active column", () => {
    expect(deriveState(task({ workspaceId: "w1" }), "none")).toBe("todo");
    expect(deriveState(task({ workspaceId: "w1" }), "done")).toBe("done");
  });
});

describe("roleToState", () => {
  it("maps every column role to its glyph state", () => {
    expect(roleToState("done")).toBe("done");
    expect(roleToState("review")).toBe("review");
    expect(roleToState("active")).toBe("working");
    expect(roleToState("queued")).toBe("queued");
    expect(roleToState("none")).toBe("todo");
  });
});

describe("firstUnmetDep", () => {
  const columns = [column("todo", "none"), column("done", "done")];

  it("returns null when there are no dependencies", () => {
    const t = task();
    expect(firstUnmetDep(t, buildBoardCtx([t], columns))).toBeNull();
  });

  it("returns null once every dependency reached a done column", () => {
    const dep = task({ id: "d1", columnId: "done" });
    const t = task({ id: "t", dependsOn: ["d1"] });
    expect(firstUnmetDep(t, buildBoardCtx([dep, t], columns))).toBeNull();
  });

  it("returns the first dependency still outside Done, in list order", () => {
    const a = task({ id: "a", columnId: "done" });
    const b = task({ id: "b", columnId: "todo" });
    const c = task({ id: "c", columnId: "todo" });
    const t = task({ id: "t", dependsOn: ["a", "b", "c"] });
    const ctx = buildBoardCtx([a, b, c, t], columns);
    expect(firstUnmetDep(t, ctx)?.id).toBe("b");
  });

  it("skips dependencies whose task no longer exists", () => {
    const t = task({ id: "t", dependsOn: ["gone"] });
    expect(firstUnmetDep(t, buildBoardCtx([t], columns))).toBeNull();
  });

  it("treats a dependency in an unknown column as unmet", () => {
    const dep = task({ id: "d1", columnId: "vanished" });
    const t = task({ id: "t", dependsOn: ["d1"] });
    expect(firstUnmetDep(t, buildBoardCtx([dep, t], columns))?.id).toBe("d1");
  });
});

describe("buildBoardCtx", () => {
  it("indexes tasks, children by parent, and column roles", () => {
    const parent = task({ id: "p" });
    const kid = task({ id: "k", parentId: "p" });
    const ctx = buildBoardCtx([parent, kid], [column("todo", "none")]);
    expect(ctx.taskById.get("k")).toBe(kid);
    expect(ctx.childrenByParent.get("p")).toEqual([kid]);
    // Only parents with children get an entry — the cards test length > 0.
    expect(ctx.childrenByParent.has("k")).toBe(false);
    expect(ctx.roleById.get("todo")).toBe("none");
  });
});

describe("depCandidates", () => {
  const columns = [column("todo", "none"), column("done", "done")];

  it("offers peers at the same level, sorted by number, minus itself", () => {
    const a = task({ id: "a", number: 3 });
    const b = task({ id: "b", number: 1 });
    const c = task({ id: "c", number: 2 });
    const ctx = buildBoardCtx([a, b, c], columns);
    expect(depCandidates(a, ctx).map((t) => t.number)).toEqual([1, 2]);
  });

  it("offers only siblings for a subtask, never top-level tasks", () => {
    const top = task({ id: "top", number: 1 });
    const sib = task({ id: "sib", number: 2, parentId: "top" });
    const me = task({ id: "me", number: 3, parentId: "top" });
    const ctx = buildBoardCtx([top, sib, me], columns);
    expect(depCandidates(me, ctx).map((t) => t.id)).toEqual(["sib"]);
  });

  it("excludes tasks already in a done column", () => {
    const a = task({ id: "a", number: 1, columnId: "done" });
    const b = task({ id: "b", number: 2 });
    const me = task({ id: "me", number: 3 });
    expect(
      depCandidates(me, buildBoardCtx([a, b, me], columns)).map((t) => t.id),
    ).toEqual(["b"]);
  });
});

describe("estimateLabel", () => {
  it("suffixes points and hours, and leaves t-shirt sizes bare", () => {
    expect(estimateLabel(8, "points")).toBe("8 points");
    expect(estimateLabel(4, "hours")).toBe("4h");
    expect(estimateLabel(3, "tshirt")).toBe("M");
  });
});
