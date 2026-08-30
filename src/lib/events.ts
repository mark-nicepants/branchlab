// Typed wrappers around Tauri's backend→frontend events.
//
// This is the event analogue of `api.ts`: the ONLY place that calls `listen`,
// so no raw event-name strings leak into components. The Rust backend
// (watcher.rs / supervisor.rs) is the source of truth and pushes state here;
// the frontend is a view over it. See AGENTS.md "Architecture & boundaries".

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AccountsPayload,
  BoardSnapshot,
  ChatBlockEvent,
  ChatCommandsEvent,
  ChatConfigEvent,
  ChatContextEvent,
  ChatEntryEvent,
  ChatPermissionEvent,
  ChatResetEvent,
  ChatTurnEvent,
  EventPayloads,
  GitHubLoginEvent,
  GitPayload,
  NotifyPayload,
  PrPayload,
  ReviewInboxPayload,
  SessionPayload,
  TodosPayload,
  WorkspaceSetupPayload,
} from "./types";

/** Subscribe to a backend event; resolves to an unsubscribe function. Keyed
 *  on `EventPayloads`, so name and payload type can't drift apart. */
function on<K extends keyof EventPayloads>(
  name: K,
  cb: (payload: EventPayloads[K]) => void,
): Promise<UnlistenFn> {
  return listen<EventPayloads[K]>(name, (e) => cb(e.payload));
}

/** Bundle several subscriptions: `dispose()` unsubscribes everything (even
 *  registrations still in flight — listen() is async), `ready` resolves true
 *  once every listener is live (false if disposed first), and `disposed`
 *  gates late async seeds. */
export function listenAll(...subs: Array<Promise<UnlistenFn>>): {
  ready: Promise<boolean>;
  dispose: () => void;
  readonly disposed: boolean;
} {
  const fns: UnlistenFn[] = [];
  let disposed = false;
  for (const p of subs) void p.then((fn) => (disposed ? fn() : fns.push(fn)));
  return {
    ready: Promise.all(subs).then(() => !disposed),
    dispose: () => {
      disposed = true;
      fns.forEach((fn) => fn());
    },
    get disposed() {
      return disposed;
    },
  };
}

/** Git state (diff stat for all workspaces; changes for the active one). */
export function onWorkspaceGit(cb: (p: GitPayload) => void) {
  return on("workspace:git", cb);
}

/** PR pipeline + autofix state for a workspace. */
export function onWorkspacePr(cb: (p: PrPayload) => void) {
  return on("workspace:pr", cb);
}

/** Coarse session state (working/idle/awaiting-input/error). */
export function onWorkspaceSession(cb: (p: SessionPayload) => void) {
  return on("workspace:session", cb);
}

/** The active workspace's todo list. */
export function onWorkspaceTodos(cb: (p: TodosPayload) => void) {
  return on("workspace:todos", cb);
}

/** Attention taps: turn done, awaiting input, task ready for review. */
export function onWorkspaceNotify(cb: (p: NotifyPayload) => void) {
  return on("workspace:notify", cb);
}

/** Workspace provisioning progress (setup script running / finished / failed). */
export function onWorkspaceSetup(cb: (p: WorkspaceSetupPayload) => void) {
  return on("workspace:setup", cb);
}

// ── GitHub subsystem (Rust `github` module) ──

/** The connected-account list changed (add/remove/re-auth). */
export function onGitHubAccounts(cb: (p: AccountsPayload) => void) {
  return on("github:accounts", cb);
}

/** A fresh review-inbox snapshot (PRs awaiting your review). */
export function onReviewInbox(cb: (p: ReviewInboxPayload) => void) {
  return on("github:review_inbox", cb);
}

/** A device-flow login lifecycle step (code/url, success, or failure). */
export function onGitHubLogin(cb: (p: GitHubLoginEvent) => void) {
  return on("github:login", cb);
}

// ── Chat deltas (Rust `chat` module) ──

/** A new/updated timeline entry (user message, assistant turn, or system notice). */
export function onChatEntry(cb: (p: ChatEntryEvent) => void) {
  return on("chat:entry", cb);
}

/** A block added/updated within an assistant turn (streaming). */
export function onChatBlock(cb: (p: ChatBlockEvent) => void) {
  return on("chat:block", cb);
}

/** An assistant turn's state-machine transition (incl. terminal + collapse). */
export function onChatTurn(cb: (p: ChatTurnEvent) => void) {
  return on("chat:turn", cb);
}

/** The agent is requesting permission for a tool call. */
export function onChatPermission(cb: (p: ChatPermissionEvent) => void) {
  return on("chat:permission", cb);
}

/** Advertised session config options (model / reasoning / mode). */
export function onChatConfig(cb: (p: ChatConfigEvent) => void) {
  return on("chat:config", cb);
}

/** The conversation was reset (new engine session); refetch the snapshot. */
export function onChatReset(cb: (p: ChatResetEvent) => void) {
  return on("chat:reset", cb);
}

/** Context-window usage for the active turn. */
export function onChatContext(cb: (p: ChatContextEvent) => void) {
  return on("chat:context", cb);
}

/** Available slash commands advertised by the agent. */
export function onChatCommands(cb: (p: ChatCommandsEvent) => void) {
  return on("chat:commands", cb);
}

/** The "My work" board changed (any mutation, incl. backend auto-moves). */
export function onTasksChanged(cb: (s: BoardSnapshot) => void) {
  return on("tasks:changed", cb);
}
