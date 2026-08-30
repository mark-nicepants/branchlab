// Pure board logic for the "My work" kanban (src/components/mywork/).
// Ordering uses fractional positions — the frontend computes midpoints, the
// backend renumbers when gaps exhaust. No React, no Tauri: unit-testable.

import { formatEstimate } from "./types";
import type {
  BoardColumn,
  ColumnRole,
  EstimateUnit,
  Task,
} from "./types";

/** The lifecycle state a card renders as, derived from column role + link. */
export type CardState = "todo" | "queued" | "working" | "review" | "done";

export function deriveState(task: Task, role: ColumnRole): CardState {
  if (role === "done") return "done";
  if (role === "review") return "review";
  if (role === "active") return task.workspaceId ? "working" : "queued";
  return "todo";
}

/** Column-role → card-state glyph when there's no task context (pickers). */
export function roleToState(role: ColumnRole): CardState {
  return role === "done"
    ? "done"
    : role === "review"
      ? "review"
      : role === "active"
        ? "working"
        : role === "queued"
          ? "queued"
          : "todo";
}

/** Board-wide lookups the cards need for parent/dependency rendering. */
export interface BoardCtx {
  taskById: Map<string, Task>;
  /** Live children keyed by parent id (only parents with children appear). */
  childrenByParent: Map<string, Task[]>;
  roleById: Map<string, ColumnRole>;
}

export function buildBoardCtx(tasks: Task[], columns: BoardColumn[]): BoardCtx {
  const childrenByParent = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.parentId) continue;
    const list = childrenByParent.get(t.parentId);
    if (list) list.push(t);
    else childrenByParent.set(t.parentId, [t]);
  }
  return {
    taskById: new Map(tasks.map((t) => [t.id, t])),
    childrenByParent,
    roleById: new Map(columns.map((c) => [c.id, c.role])),
  };
}

export const byNumber = (a: Task, b: Task) => a.number - b.number;

/** Fractional index for inserting before `next` in a sorted sibling list. */
export function positionBefore(sorted: Task[], next: Task | null): number {
  if (!next) {
    const last = sorted[sorted.length - 1];
    return (last?.position ?? 0) + 1024;
  }
  const i = sorted.findIndex((t) => t.id === next.id);
  const prev = sorted[i - 1];
  return prev ? (prev.position + next.position) / 2 : next.position / 2;
}

/** Fractional index for appending to the end of `columnId`. */
export function positionAtEnd(tasks: Iterable<Task>, columnId: string): number {
  let max = 0;
  for (const t of tasks)
    if (t.columnId === columnId && t.position > max) max = t.position;
  return max + 1024;
}

/** First dependency that still exists and hasn't reached a done column. */
export function firstUnmetDep(task: Task, ctx: BoardCtx): Task | null {
  for (const id of task.dependsOn) {
    const dep = ctx.taskById.get(id);
    if (dep && ctx.roleById.get(dep.columnId) !== "done") return dep;
  }
  return null;
}

/** Dependency candidates: peers only — siblings for a subtask, other
 *  top-level tasks otherwise — excluding itself and done-column tasks. */
export function depCandidates(task: Task, ctx: BoardCtx): Task[] {
  return [...ctx.taskById.values()]
    .filter(
      (t) =>
        t.id !== task.id &&
        t.parentId === task.parentId &&
        ctx.roleById.get(t.columnId) !== "done",
    )
    .sort(byNumber);
}

/** "8 points" / "4h" / "M" — display for a set estimate. */
export function estimateLabel(value: number, unit: EstimateUnit): string {
  if (unit === "tshirt") return formatEstimate(value, unit);
  return unit === "hours"
    ? `${formatEstimate(value, unit)}h`
    : `${formatEstimate(value, unit)} points`;
}
