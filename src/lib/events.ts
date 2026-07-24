// Typed wrappers around Tauri's backend→frontend events.
//
// This is the event analogue of `api.ts`: the ONLY place that calls `listen`,
// so no raw event-name strings leak into components. The Rust backend
// (watcher.rs / supervisor.rs) is the source of truth and pushes state here;
// the frontend is a view over it. See AGENTS.md "Architecture & boundaries".

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AccountsPayload,
  AndroidFramePayload,
  AndroidState,
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
  RunLogPayload,
  RunState,
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

/** Run state for a workspace (status + discovered dev-server ports). */
export function onWorkspaceRun(cb: (p: RunState) => void) {
  return on<RunState>("workspace:run", cb);
}

/** One line of run/setup/teardown output. */
export function onWorkspaceRunLog(cb: (p: RunLogPayload) => void) {
  return on<RunLogPayload>("workspace:run_log", cb);
}

/** A flutter-redroid workspace's Android (container) state. */
export function onWorkspaceAndroid(cb: (p: AndroidState) => void) {
  return on<AndroidState>("workspace:android", cb);
}

/** A screencap frame for the in-app Android preview. */
export function onAndroidFrame(cb: (p: AndroidFramePayload) => void) {
  return on<AndroidFramePayload>("workspace:android_frame", cb);
}

// ── GitHub subsystem (Rust `github` module) ──

/** The connected-account list changed (add/remove/re-auth). */
export function onGitHubAccounts(cb: (p: AccountsPayload) => void) {
  return on<AccountsPayload>("github:accounts", cb);
}

/** A fresh review-inbox snapshot (PRs awaiting your review). */
export function onReviewInbox(cb: (p: ReviewInboxPayload) => void) {
  return on<ReviewInboxPayload>("github:review_inbox", cb);
}

/** A device-flow login lifecycle step (code/url, success, or failure). */
export function onGitHubLogin(cb: (p: GitHubLoginEvent) => void) {
  return on<GitHubLoginEvent>("github:login", cb);
}

// ── Chat deltas (Rust `chat` module) ──

/** A new/updated timeline entry (user message, assistant turn, or system notice). */
export function onChatEntry(cb: (p: ChatEntryEvent) => void) {
  return on<ChatEntryEvent>("chat:entry", cb);
}

/** A block added/updated within an assistant turn (streaming). */
export function onChatBlock(cb: (p: ChatBlockEvent) => void) {
  return on<ChatBlockEvent>("chat:block", cb);
}

/** An assistant turn's state-machine transition (incl. terminal + collapse). */
export function onChatTurn(cb: (p: ChatTurnEvent) => void) {
  return on<ChatTurnEvent>("chat:turn", cb);
}

/** The agent is requesting permission for a tool call. */
export function onChatPermission(cb: (p: ChatPermissionEvent) => void) {
  return on<ChatPermissionEvent>("chat:permission", cb);
}

/** Advertised session config options (model / reasoning / mode). */
export function onChatConfig(cb: (p: ChatConfigEvent) => void) {
  return on<ChatConfigEvent>("chat:config", cb);
}

/** The conversation was reset (new engine session); refetch the snapshot. */
export function onChatReset(cb: (p: ChatResetEvent) => void) {
  return on<ChatResetEvent>("chat:reset", cb);
}

/** Context-window usage for the active turn. */
export function onChatContext(cb: (p: ChatContextEvent) => void) {
  return on<ChatContextEvent>("chat:context", cb);
}

/** Available slash commands advertised by the agent. */
export function onChatCommands(cb: (p: ChatCommandsEvent) => void) {
  return on<ChatCommandsEvent>("chat:commands", cb);
}
