// Mock backend event bus for the browser harness (`dev:browser`).
// Shadows events.ts. Since there is no Rust backend to push events, this bus
// lets api.mock.ts (its `resync`) fire canned payloads so the sidebar badges,
// changes list, PR bar, and todos still render. Same public surface as events.ts
// plus `mockEmit` for driving a scripted timeline.

import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  GitPayload,
  NotifyPayload,
  PrPayload,
  SessionPayload,
  TodosPayload,
} from "./types";

type Handler = (payload: unknown) => void;
const handlers: Record<string, Set<Handler>> = {};

function on<T>(name: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  (handlers[name] ??= new Set()).add(cb as Handler);
  return Promise.resolve(() => {
    handlers[name]?.delete(cb as Handler);
  });
}

/** Emit a canned event to all current subscribers (used by the mock harness). */
export function mockEmit(name: string, payload: unknown): void {
  handlers[name]?.forEach((h) => h(payload));
}

export function onWorkspaceGit(cb: (p: GitPayload) => void) {
  return on<GitPayload>("workspace:git", cb);
}
export function onWorkspacePr(cb: (p: PrPayload) => void) {
  return on<PrPayload>("workspace:pr", cb);
}
export function onWorkspaceSession(cb: (p: SessionPayload) => void) {
  return on<SessionPayload>("workspace:session", cb);
}
export function onWorkspaceTodos(cb: (p: TodosPayload) => void) {
  return on<TodosPayload>("workspace:todos", cb);
}
export function onWorkspaceNotify(cb: (p: NotifyPayload) => void) {
  return on<NotifyPayload>("workspace:notify", cb);
}
