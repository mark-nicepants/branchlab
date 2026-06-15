// Thin client for a single workspace's OpenCode HTTP server.
//
// The webview talks to the server directly over plain fetch + EventSource —
// the server allows the Tauri origin via `--cors` (see src-tauri/src/server.rs).
// Wrapping every REST call here localizes any upstream API drift.

import type {
  BusEvent,
  MessageWithParts,
  ModelOption,
  Session,
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
   * configured default. We use prompt_async and rely on the SSE stream for the
   * assistant's reply, so the UI stays responsive while the agent works.
   */
  async sendPrompt(
    sessionId: string,
    text: string,
    model?: { providerID: string; modelID: string },
  ): Promise<void> {
    await this.json(`/session/${sessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        parts: [{ type: "text", text }],
        ...(model ? { model } : {}),
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
   * Generate a short workspace name from the first user prompt. Uses a
   * throwaway session with structured output so the chat stays clean, then
   * deletes it. opencode 1.17.7 doesn't auto-title sessions, so we do it here.
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
            ...(model ? { model } : {}),
            parts: [
              {
                type: "text",
                text:
                  `Generate a concise 2-4 word title for a coding workspace based on this request. ` +
                  `Reply with ONLY the title, no quotes or punctuation.\n\nRequest: ${firstUserText}`,
              },
            ],
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
                additionalProperties: false,
              },
            },
          }),
        },
      );
      const text = res.parts?.find((p) => p.type === "text")?.text ?? "";
      const title = (JSON.parse(text) as { title?: string }).title?.trim();
      return title || null;
    } catch {
      return null;
    } finally {
      if (session) await this.json(`/session/${session.id}`, { method: "DELETE" }).catch(() => {});
    }
  }

  /** Available models, flattened from /config/providers, with the default first. */
  async listModels(): Promise<{ models: ModelOption[]; defaultLabel?: string }> {
    const data = await this.json<{
      providers: { id: string; models: Record<string, { name?: string }> }[];
      default: Record<string, string>;
    }>("/config/providers");

    const models: ModelOption[] = [];
    for (const p of data.providers) {
      for (const [modelID, info] of Object.entries(p.models)) {
        models.push({
          providerID: p.id,
          modelID,
          label: `${p.id}/${info.name ?? modelID}`,
        });
      }
    }

    // Default is { providerID: modelID }; surface the first as the preselect.
    const [defProvider, defModel] = Object.entries(data.default)[0] ?? [];
    const defaultLabel = models.find(
      (m) => m.providerID === defProvider && m.modelID === defModel,
    )?.label;

    return { models, defaultLabel };
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
