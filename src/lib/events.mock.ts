// Mock backend event bus for the browser harness (`dev:browser`).
// Shadows events.ts. Since there is no Rust backend to push events, this bus
// lets api.mock.ts fire canned payloads so the sidebar badges,
// changes list, PR bar, and todos still render. Same public surface as events.ts
// plus `mockEmit` for driving a scripted timeline.

import type { UnlistenFn } from "@tauri-apps/api/event";
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

type Handler = (payload: unknown) => void;
const handlers: Record<string, Set<Handler>> = {};

function on<K extends keyof EventPayloads>(
  name: K,
  cb: (payload: EventPayloads[K]) => void,
): Promise<UnlistenFn> {
  (handlers[name] ??= new Set()).add(cb as Handler);
  return Promise.resolve(() => {
    handlers[name]?.delete(cb as Handler);
  });
}

/** Emit a canned event to all current subscribers (used by the mock harness).
 *  Keyed on `EventPayloads`, so a typo'd name or wrong shape fails tsc. */
export function mockEmit<K extends keyof EventPayloads>(
  name: K,
  payload: EventPayloads[K],
): void {
  handlers[name]?.forEach((h) => h(payload));
}

/** Same contract as events.ts `listenAll`. */
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

export function onWorkspaceGit(cb: (p: GitPayload) => void) {
  return on("workspace:git", cb);
}
export function onWorkspacePr(cb: (p: PrPayload) => void) {
  return on("workspace:pr", cb);
}
export function onWorkspaceSession(cb: (p: SessionPayload) => void) {
  return on("workspace:session", cb);
}
export function onWorkspaceTodos(cb: (p: TodosPayload) => void) {
  return on("workspace:todos", cb);
}
export function onWorkspaceSetup(cb: (p: WorkspaceSetupPayload) => void) {
  return on("workspace:setup", cb);
}

export function onGitHubAccounts(cb: (p: AccountsPayload) => void) {
  return on("github:accounts", cb);
}
export function onReviewInbox(cb: (p: ReviewInboxPayload) => void) {
  return on("github:review_inbox", cb);
}
export function onGitHubLogin(cb: (p: GitHubLoginEvent) => void) {
  return on("github:login", cb);
}

export function onChatEntry(cb: (p: ChatEntryEvent) => void) {
  return on("chat:entry", cb);
}
export function onChatBlock(cb: (p: ChatBlockEvent) => void) {
  return on("chat:block", cb);
}
export function onChatTurn(cb: (p: ChatTurnEvent) => void) {
  return on("chat:turn", cb);
}
export function onChatPermission(cb: (p: ChatPermissionEvent) => void) {
  return on("chat:permission", cb);
}
export function onChatConfig(cb: (p: ChatConfigEvent) => void) {
  return on("chat:config", cb);
}
export function onChatReset(cb: (p: ChatResetEvent) => void) {
  return on("chat:reset", cb);
}
export function onChatContext(cb: (p: ChatContextEvent) => void) {
  return on("chat:context", cb);
}
export function onChatCommands(cb: (p: ChatCommandsEvent) => void) {
  return on("chat:commands", cb);
}

export function onWorkspaceNotify(cb: (p: NotifyPayload) => void) {
  return on("workspace:notify", cb);
}

/** The "My work" board changed (driven by api.mock's in-memory board). */
export function onTasksChanged(cb: (s: BoardSnapshot) => void) {
  return on("tasks:changed", cb);
}
