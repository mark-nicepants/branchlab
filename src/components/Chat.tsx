import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ArrowUp, ChevronUp, GitBranch, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../hooks/useChat";
import { useClipboardImages } from "../hooks/useClipboardImages";
import { useTodos } from "../hooks/useTodos";
import { chatGenerateTitle, renameWorkspace } from "../lib/api";
import { filterCommands, isSlashTyping } from "../lib/slash";
import type {
  CommandOption,
  ContextInfo,
  UserEntry,
  Workspace,
} from "../lib/types";
import {
  AssistantTurnView,
  ChatMessage,
  SystemMessageView,
} from "./ChatMessage";
import { ConfigSelect } from "./ConfigSelect";
import { ModelSelector } from "./ModelSelector";
import { PermissionView } from "./PermissionView";
import { usePreferences } from "./PreferencesProvider";
import { SlashCommandPalette } from "./SlashCommandPalette";
import { TodoButton } from "./TodoButton";

/** Lifecycle actions exposed to the parent by the composer (commit/merge/push/pr). */
export type WorkspaceAction =
  | {
      kind: "commit";
      message?: string;
      prompt: string;
      display: string;
      onFinish?: OnFinishAction;
    }
  | {
      kind: "merge";
      prompt: string;
      display: string;
      onFinish?: OnFinishAction;
    }
  | { kind: "push"; prompt: string; display: string; onFinish?: OnFinishAction }
  | {
      kind: "pr";
      title?: string;
      body?: string;
      prompt: string;
      display: string;
      onFinish?: OnFinishAction;
    };

/** Action presented to the user after a lifecycle action completes. */
export type OnFinishAction =
  | { kind: "remove_workspace"; message: string }
  | { kind: "try_again"; message: string };

interface Props {
  workspace: Workspace;
  onContext: (info: ContextInfo | null) => void;
  onRenamed: (workspaceId: string, name: string) => void;
  /** A workspace lifecycle action to run; fired then onActionConsumed is called. */
  pendingAction: WorkspaceAction | null;
  onActionConsumed: () => void;
  /** Open Settings → Models (from the model picker's "Manage models"). */
  onManageModels: () => void;
}

/** Derive a deterministic workspace title from the first user prompt. */
function deriveTitle(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.length > 48 ? `${words.slice(0, 48)}…` : words;
}

/**
 * The chat view for one workspace: a thin projection over the Rust chat layer
 * (`useChat`). All transcript state, streaming, turn tracking, and persistence
 * live in the backend; this renders entries + a composer and issues commands.
 */
export function Chat({
  workspace,
  onContext,
  onRenamed,
  pendingAction,
  onActionConsumed,
  onManageModels,
}: Props) {
  const { prefs, setWorkspacePref } = usePreferences();
  const chat = useChat(workspace.id);
  const { todos } = useTodos(workspace.id);
  const {
    attachments,
    handlePaste,
    remove: removeAttachment,
    clear: clearAttachments,
  } = useClipboardImages();

  const [input, setInput] = useState(
    prefs.workspace[workspace.id]?.inputText ?? "",
  );
  const [slashIndex, setSlashIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nameRequested = useRef(false);

  // Report context-window usage up to the session header.
  useEffect(() => {
    onContext(chat.context);
  }, [chat.context, onContext]);

  // Auto-scroll to the newest content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat.entries]);

  // Run a lifecycle action: show `display`, send `prompt`.
  useEffect(() => {
    if (!pendingAction || chat.busy) return;
    const action = pendingAction;
    void chat.send({
      display: action.display,
      sent: action.prompt,
      origin: "lifecycle",
    });
    onActionConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAction, chat.busy]);

  const saveDraft = useCallback(
    (text: string) => setWorkspacePref(workspace.id, { inputText: text }),
    [workspace.id, setWorkspacePref],
  );

  // Slash palette: OpenCode expands `/cmd args` server-side over ACP, so we send
  // the raw text (display === sent) — no client-side template expansion.
  const paletteCommands: CommandOption[] = useMemo(
    () =>
      chat.commands.map((c) => ({
        name: c.name,
        description: c.description,
        template: "",
      })),
    [chat.commands],
  );
  const showPalette = isSlashTyping(input);
  const slashMatches = showPalette
    ? filterCommands(paletteCommands, input.slice(1))
    : [];
  useEffect(() => setSlashIndex(0), [showPalette, slashMatches.length]);

  // Reasoning effort is NOT set here: opencode doesn't expose it over ACP, so it
  // is configured per-model in the opencode config (Settings → Models explains
  // how). We render whatever config options ACP advertises (model, mode, and
  // reasoning too if opencode ever adds it) — see the config map below.

  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || chat.busy) return;
    const origin = text.startsWith("/") ? "slash" : "user";

    // First interaction → title the workspace: ask the engine for an AI title
    // (throwaway session on the same connection), falling back to a deterministic
    // one if that fails or is empty.
    if (
      !workspace.name &&
      text &&
      !text.startsWith("/") &&
      !nameRequested.current
    ) {
      nameRequested.current = true;
      void chatGenerateTitle(workspace.id, text)
        .then((t) => t?.trim() || deriveTitle(text))
        .catch(() => deriveTitle(text))
        .then((title) => {
          if (title)
            return renameWorkspace(workspace.id, title).then(() =>
              onRenamed(workspace.id, title),
            );
        });
    }

    const sentAttachments = attachments.map((a) => ({
      mime: a.mime,
      url: a.url,
      filename: a.filename,
    }));
    setInput("");
    clearAttachments();
    saveDraft("");
    setError(null);
    try {
      await chat.send({
        display: text,
        sent: text,
        attachments: sentAttachments,
        origin,
      });
    } catch (e) {
      setError(String(e));
    }
  }

  function pickCommand(name: string) {
    setInput(`/${name} `);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-0 p-5">
          {chat.hasMore && (
            <button
              onClick={chat.loadMore}
              className="mx-auto mb-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronUp className="size-3.5" /> Load earlier messages
            </button>
          )}
          {workspace.base_branch && workspace.branch && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <GitBranch className="size-3.5" />
              <span>
                Branched{" "}
                <span className="font-mono text-foreground">
                  {workspace.branch}
                </span>{" "}
                from{" "}
                <span className="font-mono text-foreground">
                  {workspace.base_branch}
                </span>
              </span>
            </div>
          )}
          {!chat.loading && chat.entries.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Send a prompt to begin.
            </p>
          )}
          {chat.entries.map((entry) => {
            if (entry.type === "user")
              return <UserEntryView key={entry.entryId} entry={entry} />;
            if (entry.type === "assistant")
              return (
                <ChatMessage key={entry.entryId} role="assistant">
                  <AssistantTurnView entry={entry} />
                </ChatMessage>
              );
            return <SystemMessageView key={entry.entryId} entry={entry} />;
          })}
          {chat.permissions.map((p) => (
            <div key={p.requestId} className="flex w-full justify-start">
              <div className="w-full max-w-[85%]">
                <PermissionView
                  title={p.title}
                  options={p.options}
                  onSelect={(optionId) =>
                    chat.answerPermission(p.requestId, optionId)
                  }
                  onCancel={() => chat.answerPermission(p.requestId, null)}
                />
              </div>
            </div>
          ))}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </div>

      <div className="p-3">
        {showPalette && (
          <div className="mx-auto mb-2 max-w-4xl">
            <SlashCommandPalette
              commands={slashMatches}
              selectedIndex={slashIndex}
              onHover={setSlashIndex}
              onPick={(c) => pickCommand(c.name)}
            />
          </div>
        )}
        <div
          className={cn(
            "relative mx-auto max-w-4xl rounded-lg border border-border bg-card transition-colors duration-150 focus-within:border-ring",
            chat.busy && "composer-loading",
          )}
        >
          <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
            {chat.config.map((o) =>
              o.category === "model" ? (
                <ModelSelector
                  key={o.id}
                  option={o}
                  onChange={(v) => chat.setConfig(o.id, v)}
                  onManageModels={onManageModels}
                />
              ) : (
                <ConfigSelect
                  key={o.id}
                  option={o}
                  onChange={(v) => chat.setConfig(o.id, v)}
                />
              ),
            )}
            <div className="ml-auto flex items-center gap-1">
              <TodoButton todos={todos} />
              {chat.busy ? (
                <Button
                  variant="destructive"
                  size="icon"
                  className="size-7"
                  onClick={chat.abort}
                >
                  <Square className="size-3.5" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-primary hover:bg-primary/10 disabled:text-muted-foreground/40 disabled:hover:bg-transparent"
                  onClick={() => void send()}
                  disabled={!input.trim() && attachments.length === 0}
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
            onBlur={() => saveDraft(input)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
                return;
              }
              if (showPalette && slashMatches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashIndex((i) => (i + 1) % slashMatches.length);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashIndex(
                    (i) => (i - 1 + slashMatches.length) % slashMatches.length,
                  );
                } else if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pickCommand(slashMatches[slashIndex].name);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setInput("");
                }
              }
            }}
            placeholder="Ask the agent…  (⌘/Ctrl+Enter to send, / for commands, paste images to attach)"
            className="min-h-[80px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
      </div>
    </div>
  );
}

/** A user message bubble — shows `display` text and any image attachments. */
function UserEntryView({ entry }: { entry: UserEntry }) {
  return (
    <ChatMessage role="user">
      {entry.display && (
        <div className="whitespace-pre-wrap">{entry.display}</div>
      )}
      {entry.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {entry.attachments.map((a, i) => (
            <img
              key={i}
              src={a.url}
              alt={a.filename ?? "image"}
              className="size-16 rounded border border-border object-cover"
            />
          ))}
        </div>
      )}
    </ChatMessage>
  );
}
