import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OpencodeClient } from "../lib/opencode";
import type { BusEvent, ModelOption, Part } from "../lib/types";

interface Props {
  baseUrl: string;
}

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  partsById: Record<string, Part>;
  order: string[];
}

/**
 * Minimal streaming chat for one workspace (orchestration-first MVP).
 * Renders assistant text as it streams over SSE; tool/reasoning parts get a
 * one-line summary. Rich rendering is deferred.
 */
export function Chat({ baseUrl }: Props) {
  const client = useMemo(() => new OpencodeClient(baseUrl), [baseUrl]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, UiMessage>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<ModelOption | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const upsertPart = useCallback((part: Part) => {
    setMessages((prev) => {
      const existing = prev[part.messageID] ?? {
        id: part.messageID,
        role: "assistant" as const,
        partsById: {},
        order: [],
      };
      const order = existing.order.includes(part.id)
        ? existing.order
        : [...existing.order, part.id];
      return {
        ...prev,
        [part.messageID]: {
          ...existing,
          partsById: { ...existing.partsById, [part.id]: part },
          order,
        },
      };
    });
    setOrder((prev) => (prev.includes(part.messageID) ? prev : [...prev, part.messageID]));
  }, []);

  // Establish a session + load models once per server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sessions = await client.listSessions();
        const session = sessions[0] ?? (await client.createSession());
        if (cancelled) return;
        setSessionId(session.id);

        const { models, defaultLabel } = await client.listModels();
        if (cancelled) return;
        setModels(models);
        setModel(models.find((m) => m.label === defaultLabel) ?? models[0] ?? null);

        // Hydrate prior messages (persisted in opencode's DB).
        const history = await client.listMessages(session.id);
        if (cancelled) return;
        for (const m of history) {
          for (const p of m.parts) upsertPart({ ...p, messageID: m.info.id });
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, upsertPart]);

  // Subscribe to the SSE bus and react to message/part/idle/error events.
  useEffect(() => {
    if (!sessionId) return;
    const unsub = client.subscribeEvents((e: BusEvent) => {
      const props = e.properties as Record<string, any>;
      if (props?.sessionID && props.sessionID !== sessionId) return;
      switch (e.type) {
        case "message.part.updated":
          upsertPart(props.part as Part);
          break;
        case "message.updated":
          if (props.info) {
            const info = props.info;
            setMessages((prev) => ({
              ...prev,
              [info.id]: prev[info.id] ?? {
                id: info.id,
                role: info.role,
                partsById: {},
                order: [],
              },
            }));
            setOrder((prev) => (prev.includes(info.id) ? prev : [...prev, info.id]));
          }
          break;
        case "session.idle":
          setBusy(false);
          break;
        case "session.error":
          setError(JSON.stringify(props.error));
          setBusy(false);
          break;
      }
    });
    return unsub;
  }, [client, sessionId, upsertPart]);

  // Keep scrolled to the latest content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, order]);

  async function send() {
    const text = input.trim();
    if (!text || !sessionId || busy) return;
    setInput("");
    setError(null);
    setBusy(true);

    // Optimistic user bubble (real one arrives via SSE too, keyed by id).
    const tempId = `local-${order.length}`;
    setMessages((prev) => ({
      ...prev,
      [tempId]: {
        id: tempId,
        role: "user",
        partsById: { p: { id: "p", messageID: tempId, sessionID: sessionId, type: "text", text } },
        order: ["p"],
      },
    }));
    setOrder((prev) => [...prev, tempId]);

    try {
      await client.sendPrompt(sessionId, text, model ?? undefined);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function abort() {
    if (sessionId) await client.abort(sessionId).catch(() => {});
    setBusy(false);
  }

  return (
    <div className="chat">
      <div className="chat-messages" ref={scrollRef}>
        {order.length === 0 && <p className="muted center-text">Send a prompt to begin.</p>}
        {order.map((mid) => {
          const m = messages[mid];
          if (!m) return null;
          return (
            <div key={mid} className={`msg ${m.role}`}>
              <div className="msg-role">{m.role}</div>
              <div className="msg-body">
                {m.order.map((pid) => (
                  <PartView key={pid} part={m.partsById[pid]} />
                ))}
              </div>
            </div>
          );
        })}
        {busy && <p className="muted small">● working…</p>}
        {error && <p className="error-text">{error}</p>}
      </div>

      <div className="composer">
        <select
          value={model?.label ?? ""}
          onChange={(e) => setModel(models.find((m) => m.label === e.target.value) ?? null)}
          title="Model"
        >
          {models.length === 0 && <option value="">default model</option>}
          {models.map((m) => (
            <option key={m.label} value={m.label}>
              {m.label}
            </option>
          ))}
        </select>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Prompt the agent…  (⌘/Ctrl+Enter to send)"
          rows={3}
        />
        {busy ? (
          <button className="danger-btn" onClick={() => void abort()}>
            Stop
          </button>
        ) : (
          <button className="primary" onClick={() => void send()} disabled={!sessionId}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function PartView({ part }: { part: Part | undefined }) {
  if (!part) return null;
  if (part.type === "text") return <div className="part-text">{part.text}</div>;
  if (part.type === "reasoning")
    return <div className="part-reasoning muted">{part.text}</div>;
  if (part.type === "tool")
    return (
      <div className="part-tool muted small">
        🔧 {part.tool ?? "tool"} {part.state?.status ? `· ${part.state.status}` : ""}
      </div>
    );
  // step markers and other parts are noise in the MVP view.
  return null;
}
