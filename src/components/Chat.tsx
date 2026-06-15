import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, GitBranch, Plus, Square, Wrench } from "lucide-react";
import { OpencodeClient } from "../lib/opencode";
import type { BusEvent, ContextInfo, ModelOption, Part, Workspace } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ModelSelector } from "./ModelSelector";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface Props {
  workspace: Workspace;
  baseUrl: string;
  onRenamed: (workspaceId: string, name: string) => void;
  onContext: (info: ContextInfo | null) => void;
}

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  partsById: Record<string, Part>;
  order: string[];
}

/**
 * Minimal streaming chat for one workspace. Renders assistant text as it
 * streams over SSE; tool/reasoning parts get a one-line summary. On the first
 * user prompt (for an unnamed workspace) it asks opencode's title agent for a
 * name and reports it back via onRenamed.
 */
export function Chat({ workspace, baseUrl, onRenamed, onContext }: Props) {
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
  const nameRequested = useRef(false);
  // Kept in a ref so the SSE handler (registered once) reads current models.
  const modelsRef = useRef<ModelOption[]>([]);
  modelsRef.current = models;

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sessions = await client.listSessions();
        const session = sessions[0] ?? (await client.createSession());
        if (cancelled) return;
        setSessionId(session.id);

        const { models, defaultKey } = await client.listModels();
        if (cancelled) return;
        setModels(models);
        setModel(models.find((m) => m.key === defaultKey) ?? models[0] ?? null);

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

            // Report context-window usage from the assistant message's tokens.
            const tk = info.tokens;
            if (info.role === "assistant" && tk) {
              const used = (tk.input ?? 0) + (tk.cache?.read ?? 0);
              const max = modelsRef.current.find((m) => m.modelID === info.modelID)?.contextLimit ?? 0;
              if (used > 0 && max > 0) onContext({ used, max });
            }
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, order]);

  async function send() {
    const text = input.trim();
    if (!text || !sessionId || busy) return;
    setInput("");
    setError(null);
    setBusy(true);

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

    // First interaction → let the title agent name the workspace (background).
    if (!workspace.name && !nameRequested.current) {
      nameRequested.current = true;
      void client
        .generateName(text, model ?? undefined)
        .then((name) => name && onRenamed(workspace.id, name));
    }

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
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-5 p-5">
          {workspace.base_branch && workspace.branch && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <GitBranch className="size-3.5" />
              <span>
                Branched <span className="font-mono text-foreground">{workspace.branch}</span> from{" "}
                <span className="font-mono text-foreground">{workspace.base_branch}</span>
              </span>
            </div>
          )}
          {order.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Send a prompt to begin.
            </p>
          )}
          {order.map((mid) => {
            const m = messages[mid];
            if (!m) return null;
            return (
              <div key={mid} className="flex flex-col gap-1">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  {m.role}
                </div>
                <div
                  className={cn(
                    "select-text text-sm",
                    m.role === "user" &&
                      "self-start rounded-lg border border-border bg-card px-3 py-2",
                  )}
                >
                  {m.order.map((pid) => (
                    <PartView key={pid} part={m.partsById[pid]} />
                  ))}
                </div>
              </div>
            );
          })}
          {busy && <p className="text-xs text-muted-foreground">● working…</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </div>

      <div className="p-3">
        <div className="mx-auto max-w-4xl rounded-xl border border-border bg-card focus-within:border-muted-foreground/40">
          {/* Controls on top (Polyscope-style), composer below. */}
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-6 text-muted-foreground" disabled>
                  <Plus className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Attach (soon)</TooltipContent>
            </Tooltip>
            <ModelSelector models={models} value={model} onChange={setModel} />
            <div className="ml-auto">
              {busy ? (
                <Button variant="destructive" size="icon" className="size-7" onClick={() => void abort()}>
                  <Square className="size-3.5" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-primary hover:bg-primary/10 disabled:text-muted-foreground/40 disabled:hover:bg-transparent"
                  onClick={() => void send()}
                  disabled={!input.trim() || !sessionId}
                >
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </div>
          </div>
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask the agent…  (⌘/Ctrl+Enter to send)"
            className="min-h-[80px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
      </div>
    </div>
  );
}

function PartView({ part }: { part: Part | undefined }) {
  if (!part) return null;
  if (part.type === "text") return <div className="whitespace-pre-wrap break-words">{part.text}</div>;
  if (part.type === "reasoning")
    return <div className="whitespace-pre-wrap italic text-muted-foreground">{part.text}</div>;
  if (part.type === "tool")
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Wrench className="size-3" /> {part.tool ?? "tool"}
        {part.state?.status ? ` · ${part.state.status}` : ""}
      </div>
    );
  return null;
}
