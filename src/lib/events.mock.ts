// Mock backend event bus for the browser harness (`dev:browser`).
// Shadows events.ts. Since there is no Rust backend to push events, this bus
// lets api.mock.ts (its `resync`) fire canned payloads so the sidebar badges,
// changes list, PR bar, and todos still render. Same public surface as events.ts
// plus `mockEmit` for driving a scripted timeline.

import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  AccountsPayload,
  ChatBlockEvent,
  ChatCommandsEvent,
  ChatConfigEvent,
  ChatContextEvent,
  ChatEntryEvent,
  ChatPermissionEvent,
  ChatResetEvent,
  ChatTurnEvent,
  GitHubLoginEvent,
  GitPayload,
  NotifyPayload,
  PrPayload,
  ReviewInboxPayload,
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

export function onGitHubAccounts(cb: (p: AccountsPayload) => void) {
  return on<AccountsPayload>("github:accounts", cb);
}
export function onReviewInbox(cb: (p: ReviewInboxPayload) => void) {
  return on<ReviewInboxPayload>("github:review_inbox", cb);
}
export function onGitHubLogin(cb: (p: GitHubLoginEvent) => void) {
  return on<GitHubLoginEvent>("github:login", cb);
}

export function onChatEntry(cb: (p: ChatEntryEvent) => void) {
  return on<ChatEntryEvent>("chat:entry", cb);
}
export function onChatBlock(cb: (p: ChatBlockEvent) => void) {
  return on<ChatBlockEvent>("chat:block", cb);
}
export function onChatTurn(cb: (p: ChatTurnEvent) => void) {
  return on<ChatTurnEvent>("chat:turn", cb);
}
export function onChatPermission(cb: (p: ChatPermissionEvent) => void) {
  return on<ChatPermissionEvent>("chat:permission", cb);
}
export function onChatConfig(cb: (p: ChatConfigEvent) => void) {
  return on<ChatConfigEvent>("chat:config", cb);
}
export function onChatReset(cb: (p: ChatResetEvent) => void) {
  return on<ChatResetEvent>("chat:reset", cb);
}
export function onChatContext(cb: (p: ChatContextEvent) => void) {
  return on<ChatContextEvent>("chat:context", cb);
}
export function onChatCommands(cb: (p: ChatCommandsEvent) => void) {
  return on<ChatCommandsEvent>("chat:commands", cb);
}
