// Typed wrappers around Tauri's backend→frontend events.
//
// This is the event analogue of `api.ts`: the ONLY place that calls `listen`,
// so no raw event-name strings leak into components. The Rust backend
// (watcher.rs / supervisor.rs) is the source of truth and pushes state here;
// the frontend is a view over it. See AGENTS.md "Architecture & boundaries".

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  GitPayload,
  NotifyPayload,
  PrPayload,
  SessionPayload,
  TodosPayload,
} from "./types";

/** Subscribe to a backend event; resolves to an unsubscribe function. */
function on<T>(name: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(name, (e) => cb(e.payload));
}

/** Git state (diff stat for all workspaces; changes for the active one). */
export function onWorkspaceGit(cb: (p: GitPayload) => void) {
  return on<GitPayload>("workspace:git", cb);
}

/** PR pipeline + autofix state for a workspace. */
export function onWorkspacePr(cb: (p: PrPayload) => void) {
  return on<PrPayload>("workspace:pr", cb);
}

/** Coarse session state (working/idle/awaiting-input/error). */
export function onWorkspaceSession(cb: (p: SessionPayload) => void) {
  return on<SessionPayload>("workspace:session", cb);
}

/** The active workspace's todo list. */
export function onWorkspaceTodos(cb: (p: TodosPayload) => void) {
  return on<TodosPayload>("workspace:todos", cb);
}

/** Discrete notification signals (turn done, awaiting input, pipeline status). */
export function onWorkspaceNotify(cb: (p: NotifyPayload) => void) {
  return on<NotifyPayload>("workspace:notify", cb);
}
