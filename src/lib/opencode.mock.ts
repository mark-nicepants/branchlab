// Mock OpenCode HTTP client for browser-based visual debugging.
// Shadows src/lib/opencode.ts under `npm run dev:browser` (see vite.config.ts).
// It never opens a socket; it returns canned sessions/messages/models so the
// session (chat) view renders a realistic conversation without a live server.

import type {
  AgentOption,
  BusEvent,
  CommandOption,
  LspStatus,
  McpStatus,
  MessageWithParts,
  ModelOption,
  QuestionRequest,
  QuestionV2Request,
  Session,
  Todo,
} from "./types";

const MOCK_MODELS: ModelOption[] = [
  {
    key: "anthropic/claude-opus-4-8",
    providerID: "anthropic",
    providerName: "Anthropic",
    modelID: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    contextLimit: 1_000_000,
    variants: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    key: "anthropic/claude-sonnet-5",
    providerID: "anthropic",
    providerName: "Anthropic",
    modelID: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    contextLimit: 400_000,
    variants: ["low", "medium", "high"],
  },
  {
    key: "openai/gpt-5",
    providerID: "openai",
    providerName: "OpenAI",
    modelID: "gpt-5",
    name: "GPT-5",
    contextLimit: 256_000,
    variants: [],
  },
];

let sessionSeq = 0;

function mockHistory(sessionId: string): MessageWithParts[] {
  const mk = (id: string, type: string, extra: Record<string, unknown>) => ({
    id,
    messageID: "",
    sessionID: sessionId,
    type,
    ...extra,
  });
  return [
    {
      info: { id: "m-user", role: "user" as const, sessionID: sessionId },
      parts: [
        {
          ...mk("p-u1", "text", {
            text: "merge develop into this and fix the merge conflicts. Ensure all tests stay green",
          }),
          messageID: "m-user",
        },
      ],
    },
    {
      info: {
        id: "m-assistant",
        role: "assistant" as const,
        sessionID: sessionId,
        tokens: { input: 48_200, output: 1_240, cache: { read: 12_000 } },
      },
      parts: [
        {
          ...mk("p-a1", "text", {
            text: "I'll start by renaming the working branch to a clean kebab-case name, then merge `develop`, resolve conflicts, and run the test suite.",
          }),
          messageID: "m-assistant",
        },
        {
          ...mk("p-a2", "tool", {
            tool: "bash",
            state: {
              status: "completed",
              title: "git --no-pager status --short",
              output: "M src/App.tsx\nM vite.config.ts",
            },
          }),
          messageID: "m-assistant",
        },
        {
          ...mk("p-a3", "tool", {
            tool: "bash",
            state: {
              status: "completed",
              title: "git merge origin/develop",
              output:
                "Auto-merging src/App.tsx\nCONFLICT (content): Merge conflict in src/App.tsx",
            },
          }),
          messageID: "m-assistant",
        },
        {
          ...mk("p-a4", "text", {
            text: "There's a conflict in `src/App.tsx`. Resolving it by keeping both the new shell layout and the upstream provider changes.",
          }),
          messageID: "m-assistant",
        },
        {
          ...mk("p-a5", "tool", {
            tool: "edit",
            state: {
              status: "completed",
              title: "Resolve conflict in src/App.tsx",
            },
          }),
          messageID: "m-assistant",
        },
        {
          ...mk("p-a6", "tool", {
            tool: "bash",
            state: { status: "running", title: "npm test" },
          }),
          messageID: "m-assistant",
        },
      ],
    },
  ];
}

export class OpencodeClient {
  // baseUrl is accepted for API parity but ignored by the mock.
  constructor(_baseUrl: string) {}

  health(): Promise<{ healthy: boolean; version: string }> {
    return Promise.resolve({ healthy: true, version: "1.17.4" });
  }

  listSessions(): Promise<Session[]> {
    return Promise.resolve([]);
  }

  createSession(): Promise<Session> {
    sessionSeq += 1;
    return Promise.resolve({
      id: `mock-session-${sessionSeq}`,
      title: "",
      directory: "/mock",
      projectID: "mock",
    });
  }

  listMessages(sessionId: string): Promise<MessageWithParts[]> {
    return Promise.resolve(mockHistory(sessionId));
  }

  sendPrompt(): Promise<void> {
    return Promise.resolve();
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  getDiff(): Promise<unknown> {
    return Promise.resolve(null);
  }

  generateName(): Promise<string | null> {
    return Promise.resolve("Merge develop & fix conflicts");
  }

  getConfig(): Promise<unknown> {
    return Promise.resolve({});
  }

  listAgents(): Promise<AgentOption[]> {
    return Promise.resolve([
      { name: "build", mode: "primary", description: "Full read/write agent" },
      {
        name: "plan",
        mode: "primary",
        description: "Read-only planning agent",
      },
    ]);
  }

  listTodos(): Promise<Todo[]> {
    return Promise.resolve([
      {
        content: "Merge origin/develop",
        status: "completed",
        priority: "high",
      },
      {
        content: "Resolve conflicts in src/App.tsx",
        status: "completed",
        priority: "high",
      },
      {
        content: "Run the test suite",
        status: "in_progress",
        priority: "medium",
      },
    ]);
  }

  listCommands(): Promise<CommandOption[]> {
    return Promise.resolve([
      {
        name: "review",
        description: "Review the current diff",
        template: "Review: $ARGUMENTS",
      },
      {
        name: "test",
        description: "Run the test suite",
        template: "Run the tests",
      },
    ]);
  }

  listQuestionsV2(): Promise<QuestionV2Request[]> {
    return Promise.resolve([]);
  }
  replyQuestionV2(): Promise<void> {
    return Promise.resolve();
  }
  rejectQuestionV2(): Promise<void> {
    return Promise.resolve();
  }
  listQuestions(): Promise<QuestionRequest[]> {
    return Promise.resolve([]);
  }
  replyQuestion(): Promise<void> {
    return Promise.resolve();
  }
  rejectQuestion(): Promise<void> {
    return Promise.resolve();
  }

  listMcp(): Promise<McpStatus[]> {
    return Promise.resolve([
      { name: "context7", status: "connected" },
      { name: "playwright", status: "connected" },
      { name: "microsoft-learn", status: "disabled" },
    ]);
  }
  connectMcp(): Promise<unknown> {
    return Promise.resolve(null);
  }
  disconnectMcp(): Promise<unknown> {
    return Promise.resolve(null);
  }

  listLsp(): Promise<LspStatus[]> {
    return Promise.resolve([
      { id: "typescript", status: "running" },
      { id: "rust-analyzer", status: "running" },
    ]);
  }

  listPlugins(): Promise<string[]> {
    return Promise.resolve(["opencode-notifications", "opencode-github"]);
  }

  listModels(): Promise<{ models: ModelOption[]; defaultKey?: string }> {
    return Promise.resolve({
      models: MOCK_MODELS,
      defaultKey: "anthropic/claude-opus-4-8",
    });
  }

  subscribeEvents(_onEvent: (e: BusEvent) => void): () => void {
    // No live event stream in the mock; history is static.
    return () => {};
  }
}
