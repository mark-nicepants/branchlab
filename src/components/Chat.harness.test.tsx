// One integration test over the browser dev harness (`dev:browser`).
//
// The "harness" vitest project mirrors vite.config.ts's browser aliasing, so
// `../lib/api` → api.mock and `../lib/events` → events.mock. That makes the
// mock event bus the real backend for this test: `mockEmit` pushes the same
// `chat:*` deltas the Rust chat layer emits, through the real `useChat` and
// the real transcript components.
//
// Scope is deliberately one flow — a streaming assistant turn end to end. The
// mocks are a debugging aid, not a contract; a broad component suite built on
// their canned timelines would become a second thing to keep in sync.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Chat } from "./Chat";
import { useChat } from "../hooks/useChat";
import { mockEmit } from "../lib/events.mock";
import type { Workspace } from "../lib/types";

const WS_ID = "harness-ws";

const workspace: Workspace = {
  id: WS_ID,
  project_id: "p1",
  kind: "Worktree",
  path: "/tmp/harness",
  branch: "feat/streaming",
  name: "Harness",
  base_branch: "main",
  init_prompt: null,
  autofix_mode: "off",
  model: null,
  effort: null,
  pr_number: null,
  pr_is_fork: false,
  pr: null,
  setup: "ready",
};

const summary = {
  collapsed: false,
  stepCount: 0,
  filesEdited: [],
  commandsRun: 0,
  headline: "",
};

/** Mirrors SessionView: the store is owned above Chat and passed in. */
function Harness() {
  const chat = useChat(WS_ID);
  return (
    <Chat
      workspace={workspace}
      chat={chat}
      onRenamed={() => {}}
      pendingAction={null}
      onActionConsumed={() => {}}
      onManageModels={() => {}}
    />
  );
}

beforeAll(() => {
  // Radix primitives in the composer's selectors need these; jsdom has neither.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollTo ??= () => {};
});

afterEach(cleanup);

describe("Chat over the mock backend", () => {
  it("renders a full streaming turn driven by chat:* events", async () => {
    render(<Harness />);

    // The store seeds from `chatOpen` and only then attaches listeners; an
    // event emitted before that would be dropped, exactly as in the app.
    await screen.findByText("Send a prompt to begin.");

    const emit = (fn: () => void) => act(() => fn());

    emit(() =>
      mockEmit("chat:entry", {
        workspaceId: WS_ID,
        entry: {
          type: "user",
          seq: 1,
          entryId: "u1",
          display: "run the tests",
          sent: "run the tests",
          attachments: [],
          model: null,
          variant: null,
          agent: null,
          origin: "user",
          createdAt: Date.now(),
        },
      }),
    );
    expect(screen.getByText("run the tests")).toBeTruthy();
    expect(screen.queryByText("Send a prompt to begin.")).toBeNull();

    emit(() =>
      mockEmit("chat:entry", {
        workspaceId: WS_ID,
        entry: {
          type: "assistant",
          seq: 2,
          entryId: "a2",
          status: "streaming",
          origin: "user",
          blocks: [],
          summary,
          usage: null,
          startedAt: Date.now(),
          endedAt: null,
        },
      }),
    );

    // Stream a tool step: pending → completed, same blockId both times.
    const bash = (status: "pending" | "completed", output: string | null) =>
      mockEmit("chat:block", {
        workspaceId: WS_ID,
        entrySeq: 2,
        block: {
          type: "tool",
          blockId: "blk-tool",
          callId: "call-1",
          name: "bash",
          title: null,
          status,
          input: { command: "npm test" },
          output,
          diff: null,
        },
      });
    emit(() => bash("pending", null));
    emit(() => bash("completed", "190 passed"));

    // Stream prose in three full-block deliveries, the last one duplicated —
    // the transport is at-least-once and every event carries the whole block.
    const prose = (text: string) =>
      mockEmit("chat:block", {
        workspaceId: WS_ID,
        entrySeq: 2,
        block: { type: "text", blockId: "blk-text", text },
      });
    emit(() => prose("All "));
    emit(() => prose("All 190 "));
    emit(() => prose("All 190 tests passed."));
    emit(() => prose("All 190 tests passed."));

    emit(() =>
      mockEmit("chat:turn", {
        workspaceId: WS_ID,
        entrySeq: 2,
        status: "completed",
        summary: {
          ...summary,
          stepCount: 1,
          commandsRun: 1,
          headline: "Ran the tests",
        },
        usage: null,
        endedAt: Date.now() + 4200,
      }),
    );

    await waitFor(() => {
      // The tool step renders as one collapsed row: verb + mono object.
      expect(screen.getByText("Ran")).toBeTruthy();
      expect(screen.getByText("npm test")).toBeTruthy();
      // The turn summary replaced the live "Working — n steps" headline.
      expect(screen.getByText("Ran the tests")).toBeTruthy();
    });

    // Streamed text is upserted, never appended: exactly one final block, and
    // no partial left behind by the re-deliveries.
    expect(screen.getAllByText("All 190 tests passed.")).toHaveLength(1);
    expect(screen.queryByText("All 190")).toBeNull();
    expect(screen.queryByText("All")).toBeNull();
  });
});
