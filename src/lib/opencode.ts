// Thin client for a single workspace's OpenCode HTTP server.
//
// The webview talks to the server directly over plain fetch + EventSource —
// the server allows the Tauri origin via `--cors` (see src-tauri/src/server.rs).
// Wrapping every REST call here localizes any upstream API drift.

import type {
  AgentOption,
  BusEvent,
  LspStatus,
  McpStatus,
  MessageWithParts,
  ModelOption,
  Session,
  Todo,
} from "./types";

export class OpencodeClient {
  constructor(private baseUrl: string) {}

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
    if (!res.ok) {
      throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  health(): Promise<{ healthy: boolean; version: string }> {
    return this.json("/global/health");
  }

  listSessions(): Promise<Session[]> {
    return this.json("/session");
  }

  createSession(): Promise<Session> {
    return this.json("/session", { method: "POST", body: "{}" });
  }

  listMessages(sessionId: string): Promise<MessageWithParts[]> {
    return this.json(`/session/${sessionId}/message`);
  }

  /**
   * Send a user prompt. `model` is optional — omitting it uses the server's
   * configured default. `variant` selects the model's reasoning effort (e.g.
   * "high"); omit it to use the model's default. `agent` selects the OpenCode
   * agent/mode (e.g. "build", "plan"); omit it to use the server's default
   * agent. We use prompt_async and rely on the SSE stream for the assistant's
   * reply, so the UI stays responsive while the agent works.
   */
  async sendPrompt(
    sessionId: string,
    text: string,
    model?: { providerID: string; modelID: string },
    variant?: string,
    agent?: string,
  ): Promise<void> {
    await this.json(`/session/${sessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        parts: [{ type: "text", text }],
        ...(model ? { model } : {}),
        ...(variant ? { variant } : {}),
        ...(agent ? { agent } : {}),
      }),
    });
  }

  abort(sessionId: string): Promise<void> {
    return this.json(`/session/${sessionId}/abort`, { method: "POST", body: "{}" });
  }

  getDiff(sessionId: string): Promise<unknown> {
    return this.json(`/session/${sessionId}/diff`);
  }

  /**
   * Generate a workspace name from the first user prompt using opencode's
   * built-in `title` agent (purpose-built, no tool use). Runs in a throwaway
   * session so the chat stays clean, then deletes it. opencode 1.17.7 doesn't
   * auto-title sessions, so we drive it explicitly here.
   */
  async generateName(
    firstUserText: string,
    model?: { providerID: string; modelID: string },
  ): Promise<string | null> {
    let session: Session | null = null;
    try {
      session = await this.createSession();
      const res = await this.json<{ parts?: { type: string; text?: string }[] }>(
        `/session/${session.id}/message`,
        {
          method: "POST",
          body: JSON.stringify({
            agent: "title",
            ...(model ? { model } : {}),
            parts: [{ type: "text", text: firstUserText }],
          }),
        },
      );
      const text = res.parts?.find((p) => p.type === "text")?.text?.trim();
      return text || null;
    } catch {
      return null;
    } finally {
      if (session) await this.json(`/session/${session.id}`, { method: "DELETE" }).catch(() => {});
    }
  }

  /** Effective merged config (read-only view). */
  getConfig(): Promise<unknown> {
    return this.json("/config");
  }

  /** Available agents (build, plan, title, …). */
  listAgents(): Promise<AgentOption[]> {
    return this.json("/agent");
  }

  /** Session todo list. */
  listTodos(sessionId: string): Promise<Todo[]> {
    return this.json(`/session/${sessionId}/todo`);
  }

  /** Available slash commands. */
  listCommands(): Promise<{ name: string; description?: string }[]> {
    return this.json("/command");
  }

  /** MCP servers with runtime status (`/mcp` → `{ name: { status, error? } }`). */
  async listMcp(): Promise<McpStatus[]> {
    const data = await this.json<Record<string, { status?: string; error?: string }>>("/mcp");
    return Object.entries(data)
      .map(([name, v]) => ({ name, status: v.status ?? "unknown", error: v.error }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Connect (enable) an MCP server at runtime. */
  connectMcp(name: string): Promise<unknown> {
    return this.json(`/mcp/${encodeURIComponent(name)}/connect`, { method: "POST", body: "{}" });
  }

  /** Disconnect (disable) an MCP server at runtime. */
  disconnectMcp(name: string): Promise<unknown> {
    return this.json(`/mcp/${encodeURIComponent(name)}/disconnect`, { method: "POST", body: "{}" });
  }

  /** LSP servers with runtime status (`/lsp`). */
  async listLsp(): Promise<LspStatus[]> {
    const data = await this.json<{ id?: string; status?: string; state?: string }[]>("/lsp");
    return (data ?? []).map((l, i) => ({ id: l.id ?? `lsp-${i}`, status: l.status ?? l.state }));
  }

  /** Configured plugin names, from the effective config's `plugin` array. */
  async listPlugins(): Promise<string[]> {
    const cfg = await this.json<{ plugin?: string[] }>("/config");
    return cfg.plugin ?? [];
  }

  /** Available models grouped from /config/providers, with the default key. */
  async listModels(): Promise<{ models: ModelOption[]; defaultKey?: string }> {
    const data = await this.json<{
      providers: {
        id: string;
        name?: string;
        models: Record<
          string,
          {
            name?: string;
            limit?: { context?: number };
            // Reasoning-effort variants, keyed by name (e.g. "low", "high").
            variants?: Record<string, unknown>;
          }
        >;
      }[];
      default: Record<string, string>;
    }>("/config/providers");

    const models: ModelOption[] = [];
    for (const p of data.providers) {
      for (const [modelID, info] of Object.entries(p.models)) {
        models.push({
          key: `${p.id}/${modelID}`,
          providerID: p.id,
          providerName: p.name ?? p.id,
          modelID,
          name: info.name ?? modelID,
          contextLimit: info.limit?.context,
          variants: info.variants ? Object.keys(info.variants) : [],
        });
      }
    }
    models.sort((a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name));

    // Default is { providerID: modelID }; surface the first as the preselect.
    const [defProvider, defModel] = Object.entries(data.default)[0] ?? [];
    const defaultKey = defProvider && defModel ? `${defProvider}/${defModel}` : undefined;

    return { models, defaultKey };
  }

  /**
   * Subscribe to the server's SSE event bus. Returns an unsubscribe fn.
   * EventSource auto-reconnects; callers handle event filtering by `type`.
   */
  subscribeEvents(onEvent: (e: BusEvent) => void): () => void {
    const es = new EventSource(`${this.baseUrl}/event`);
    es.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as BusEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => es.close();
  }
}
