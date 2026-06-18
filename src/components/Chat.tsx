import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, GitBranch, Square, X } from "lucide-react";
import { OpencodeClient } from "../lib/opencode";
import type { BusEvent, ContextInfo, ModelOption, Part, Session, Todo, Workspace } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ModelSelector } from "./ModelSelector";
import { ModeSelector } from "./ModeSelector";
import { ThinkingSelector } from "./ThinkingSelector";
import { ChatMessage, PartView, SystemMessageView } from "./ChatMessage";
import { TodoButton } from "./TodoButton";
import { usePreferences } from "./PreferencesProvider";

interface Props {
  workspace: Workspace;
  baseUrl: string;
  onRenamed: (workspaceId: string, name: string) => void;
  onContext: (info: ContextInfo | null) => void;
  onAction?: (action: WorkspaceAction) => void;
}

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  partsById: Record<string, Part>;
  order: string[];
}

/** Local-only system notice inserted for workspace lifecycle actions. */
export interface SystemMessage {
  id: string;
  content: string;
  kind: "info" | "success" | "error";
  align?: "left" | "center";
}

/** Lifecycle actions exposed to the parent by Chat. */
export type WorkspaceAction =
  | { kind: "commit"; message?: string; prompt: string; display: string; onFinish?: OnFinishAction }
  | { kind: "merge"; prompt: string; display: string; onFinish?: OnFinishAction }
  | { kind: "push"; prompt: string; display: string; onFinish?: OnFinishAction }
  | { kind: "pr"; title?: string; body?: string; prompt: string; display: string; onFinish?: OnFinishAction };

/** Action presented to the user after a lifecycle action completes. */
export type OnFinishAction =
  | { kind: "remove_workspace"; message: string }
  | { kind: "try_again"; message: string };

/** Two todo lists are equal when they have the same contents and statuses in order. */
function sameTodoList(a: Todo[], b: Todo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].content !== b[i].content || a[i].status !== b[i].status) return false;
  }
  return true;
}

/**
 * Minimal streaming chat for one workspace. Renders assistant text as it
 * streams over SSE; tool/reasoning parts get a one-line summary. On the first
 * user prompt (for an unnamed workspace) it asks opencode's title agent for a
 * name and reports it back via onRenamed.
 */
export function Chat({ workspace, baseUrl, onRenamed, onContext, onAction }: Props) {
  const { prefs, setWorkspacePref } = usePreferences();
  const client = useMemo(() => new OpencodeClient(baseUrl), [baseUrl]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, UiMessage>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<ModelOption | null>(null);
  // Selected reasoning effort for the active model; null = the model's default.
  const [variant, setVariant] = useState<string | null>(null);
  // Selected OpenCode agent/mode; only "build" or "plan".
  const [agent, setAgent] = useState<string>("build");
  const [input, setInput] = useState(prefs.workspace[workspace.id]?.inputText ?? "");
  // Image attachments pasted from the clipboard, sent alongside the next prompt.
  const [attachments, setAttachments] = useState<{ id: string; mime: string; url: string; filename: string }[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  // Snapshot of a fully-completed todo list dismissed by the user starting a
  // new turn. Polling hides this exact list until the assistant produces a
  // different one (compared by content+status).
  // Setter-only — the value is read inside the setter callback below.
  const [, setDismissedTodos] = useState<Todo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [systemMessages, setSystemMessages] = useState<SystemMessage[]>([]);
  const [pendingOnFinish, setPendingOnFinish] = useState<OnFinishAction | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nameRequested = useRef(false);
  // Tracks whether we are currently running a lifecycle action so we can detect
  // when the assistant goes idle and present the follow-up UI.
  const lifecycleBusy = useRef(false);
  // Set to true if any tool error or session error occurs during a lifecycle action.
  const lifecycleError = useRef(false);
  // Kept in a ref so the SSE handler (registered once) reads current models.
  const modelsRef = useRef<ModelOption[]>([]);
  modelsRef.current = models;
  // Tracks whether the workspace init prompt has already been sent.
  const initPromptSent = useRef(false);
  // Mirror the composer draft so we can persist it on unmount without causing
  // a context update (and therefore global re-render) on every keystroke.
  const inputRef = useRef(input);
  inputRef.current = input;

  const clearSystemMessages = useCallback(() => setSystemMessages([]), []);

  // Clear transient lifecycle notices when the workspace changes.
  useEffect(() => {
    clearSystemMessages();
  }, [workspace.id, clearSystemMessages]);

  // Lifecycle actions come from the workspace header buttons. We send the
  // technical prompt to the AI but surface a friendly message in the chat.
  useEffect(() => {
    if (!onAction) return;
    const handler = (e: Event) => {
      const action = (e as CustomEvent<WorkspaceAction>).detail;
      if (!sessionId || busy) return;
      setSystemMessages((prev) => [
        ...prev,
        {
          id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          content: action.display,
          kind: "info",
          align: "left",
        },
      ]);
      lifecycleBusy.current = true;
      lifecycleError.current = false;
      setBusy(true);
      setError(null);
      if (action.onFinish) {
        setPendingOnFinish(action.onFinish);
      }
      void client.sendPrompt(
        sessionId,
        action.prompt,
        model ?? undefined,
        variant ?? undefined,
        agent,
        [],
      );
    };
    const el = document.getElementById("workspace-actions");
    el?.addEventListener("workspace-action", handler);
    return () => el?.removeEventListener("workspace-action", handler);
  }, [onAction, sessionId, busy, client, model, variant, agent]);

  // When the assistant finishes a lifecycle action, show the configured
  // follow-up message. Success/failure is inferred from tool/session errors
  // that occurred while the action was running.
  useEffect(() => {
    if (!lifecycleBusy.current || busy) return;
    lifecycleBusy.current = false;
    const action = pendingOnFinish;
    if (!action) return;
    setPendingOnFinish(null);
    const kind = lifecycleError.current ? "error" : "success";
    setSystemMessages((prev) => [
      ...prev,
      {
        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content: action.message,
        kind,
        align: "left",
      },
    ]);
  }, [busy, pendingOnFinish]);

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
        const savedId = prefs.workspace[workspace.id]?.sessionId;

        // Reuse the persisted session only if the server still knows about it.
        let session: Session | undefined = savedId
          ? sessions.find((s) => s.id === savedId)
          : undefined;

        // Otherwise create a fresh session for this workspace so worktrees never
        // inherit the base repo's chat history. opencode stores sessions in a
        // directory-keyed DB, and git worktrees share the same underlying git
        // directory, so `sessions[0]` on a new worktree would otherwise be the
        // base workspace's session.
        if (!session) {
          session = await client.createSession();
          setWorkspacePref(workspace.id, { sessionId: session.id });
        }

        if (cancelled) return;
        setSessionId(session.id);

        const { models, defaultKey } = await client.listModels();
        if (cancelled) return;
        setModels(models);

        // Restore the workspace's last selected model, or fall back to default.
        const savedKey = prefs.workspace[workspace.id]?.modelKey;
        const initialModel =
          models.find((m) => m.key === savedKey) ??
          models.find((m) => m.key === defaultKey) ??
          models[0] ??
          null;
        setModel(initialModel);

        // Restore the workspace's last reasoning-effort variant, if the model
        // still supports it.
        const savedVariant = prefs.workspace[workspace.id]?.variant;
        if (savedVariant && initialModel?.variants.includes(savedVariant)) {
          setVariant(savedVariant);
        }

        const history = await client.listMessages(session.id);
        if (cancelled) return;
        // Build the message map directly from history so each message keeps
        // its correct role. (Going through upsertPart would default every
        // history message to "assistant".)
        const loadedMessages: Record<string, UiMessage> = {};
        const loadedOrder: string[] = [];
        for (const m of history) {
          const ui: UiMessage = {
            id: m.info.id,
            role: m.info.role,
            partsById: {},
            order: [],
          };
          for (const p of m.parts) {
            const part = { ...p, messageID: m.info.id };
            ui.partsById[p.id] = part;
            ui.order.push(p.id);
          }
          loadedMessages[m.info.id] = ui;
          loadedOrder.push(m.info.id);
        }
        setMessages(loadedMessages);
        setOrder(loadedOrder);

        // Send the workspace init prompt once after the session is ready.
        const initPrompt = workspace.init_prompt?.trim();
        if (initPrompt && !initPromptSent.current && !cancelled) {
          initPromptSent.current = true;
          setSystemMessages((prev) => [
            ...prev,
            {
              id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              content: "Initializing workspace…",
              kind: "info",
              align: "left",
            },
          ]);
          lifecycleBusy.current = true;
          lifecycleError.current = false;
          setBusy(true);
          void client.sendPrompt(session.id, initPrompt, model ?? undefined, variant ?? undefined, agent, []);
        }

        // Report context usage from the most recent assistant message in history.
        const lastAssistant = [...history].reverse().find((m) => m.info.role === "assistant");
        const tk = lastAssistant?.info.tokens;
        if (tk) {
          const used = (tk.input ?? 0) + (tk.cache?.read ?? 0);
          const max = models.find((m) => m.key === savedKey)?.contextLimit ?? 0;
          if (used > 0 && max > 0) onContext({ used, max });
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
        case "message.part.updated": {
          const part = props.part as Part;
          if (lifecycleBusy.current && part.type === "tool" && part.state?.status === "error") {
            lifecycleError.current = true;
          }
          upsertPart(part);
          break;
        }
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
          if (lifecycleBusy.current) {
            lifecycleError.current = true;
          }
          setError(JSON.stringify(props.error));
          setBusy(false);
          break;
      }
    });
    return unsub;
  }, [client, sessionId, upsertPart]);

  // Poll the session todo list while we have an active session.
  useEffect(() => {
    if (!sessionId) return;
    const fetchTodos = () => {
      client
        .listTodos(sessionId)
        .then((list) => {
          // If the polled list matches a previously-dismissed snapshot
          // (everything completed when the user sent a new turn), keep it
          // hidden until the assistant produces a different list.
          setDismissedTodos((dismissed) => {
            if (dismissed && sameTodoList(list, dismissed)) {
              setTodos([]);
              return dismissed;
            }
            setTodos(list);
            return null;
          });
        })
        .catch(() => {});
    };
    fetchTodos();
    const t = setInterval(fetchTodos, 2000);
    return () => clearInterval(t);
  }, [client, sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, order]);

  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || !sessionId || busy) return;
    const sentAttachments = attachments;
    setInput("");
    setAttachments([]);
    saveDraft("");
    setError(null);
    setBusy(true);

    // If every current todo is completed, treat the new turn as a fresh start
    // and hide them from the badge until the assistant produces a new list.
    if (todos.length > 0 && todos.every((t) => t.status === "completed")) {
      setDismissedTodos(todos);
      setTodos([]);
    }

    // Note: we do not optimistically render the user message. OpenCode echoes
    // it back via SSE as a real message, so adding it here would duplicate it.

    // First interaction → let the title agent name the workspace (background).
    if (!workspace.name && text && !nameRequested.current) {
      nameRequested.current = true;
      void client
        .generateName(text, model ?? undefined)
        .then((name) => name && onRenamed(workspace.id, name));
    }

    try {
      await client.sendPrompt(
        sessionId,
        text,
        model ?? undefined,
        variant ?? undefined,
        agent,
        sentAttachments.map((a) => ({ mime: a.mime, url: a.url, filename: a.filename })),
      );
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  // Intercept image items from the clipboard. Each item is read as a data URL
  // (a base64-encoded image inline), which is what opencode's FilePartInput
  // expects for the `url` field. Non-image clipboard contents fall through to
  // the textarea's default paste behavior (text).
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? []).filter((it) =>
      it.type.startsWith("image/"),
    );
    if (items.length === 0) return;
    e.preventDefault();
    for (const item of items) {
      const blob = item.getAsFile();
      if (!blob) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result as string;
        const ext = blob.type.split("/")[1] ?? "png";
        setAttachments((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            mime: blob.type,
            url,
            filename: blob.name || `pasted-${Date.now()}.${ext}`,
          },
        ]);
      };
      reader.readAsDataURL(blob);
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  async function abort() {
    if (sessionId) await client.abort(sessionId).catch(() => {});
    setBusy(false);
  }

  // Switch model and drop the reasoning effort if the new model can't honor it.
  // Persist the selected model per workspace.
  function changeModel(next: ModelOption) {
    setModel(next);
    const keep = variant && next.variants.includes(variant) ? variant : null;
    setVariant(keep);
    setWorkspacePref(workspace.id, { modelKey: next.key, variant: keep ?? "" });
  }

  // Persist the selected reasoning-effort variant per workspace.
  function changeVariant(next: string | null) {
    setVariant(next);
    setWorkspacePref(workspace.id, { variant: next ?? "" });
  }

  // Preserve the composer draft per workspace, but don't update the global
  // preference context on every keystroke — that re-renders the whole UI.
  // Save only when the prompt is sent or the component unmounts.
  const saveDraft = useCallback((text: string) => {
    setWorkspacePref(workspace.id, { inputText: text });
  }, [workspace.id, setWorkspacePref]);

  useEffect(() => {
    return () => saveDraft(inputRef.current);
  }, [saveDraft]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-0 p-5">
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
              <ChatMessage key={mid} role={m.role}>
                {m.order.map((pid) => (
                  <PartView key={pid} part={m.partsById[pid]} />
                ))}
              </ChatMessage>
            );
          })}
          {systemMessages.map((sys) => (
            <SystemMessageView key={sys.id} message={sys} />
          ))}
          {busy && <p className="text-xs text-muted-foreground">● working…</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </div>

      <div className="p-3">
        <div className="composer-shadow mx-auto max-w-4xl rounded-2xl border border-border bg-card transition-shadow focus-within:border-muted-foreground/40">
          {/* Controls on top (Polyscope-style), composer below. */}
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <ModeSelector value={agent} onChange={setAgent} />
            <ModelSelector models={models} value={model} onChange={changeModel} />
            <ThinkingSelector
              variants={model?.variants ?? []}
              value={variant}
              onChange={changeVariant}
            />
            <div className="ml-auto flex items-center gap-1">
              <TodoButton todos={todos} />
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
                  disabled={(!input.trim() && attachments.length === 0) || !sessionId}
                >
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </div>
          </div>
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-2 pb-1.5">
              {attachments.map((a) => (
                <div key={a.id} className="group relative">
                  <img
                    src={a.url}
                    alt={a.filename}
                    className="size-16 rounded border border-border object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                    aria-label="Remove attachment"
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask the agent…  (⌘/Ctrl+Enter to send, paste images to attach)"
            className="min-h-[80px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
      </div>
    </div>
  );
}


