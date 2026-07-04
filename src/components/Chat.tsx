import { ChevronUp, GitBranch } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatStore } from "../hooks/useChat";
import { useClipboardImages } from "../hooks/useClipboardImages";
import { useTodos } from "../hooks/useTodos";
import { chatGenerateTitle, renameWorkspace } from "../lib/api";
import { filterCommands, isSlashTyping } from "../lib/slash";
import type { CommandOption, Workspace } from "../lib/types";
import { ActiveTodoStrip } from "./ActiveTodoStrip";
import {
  AssistantTurnView,
  MessageShell,
  SystemMessageView,
  UserMessageView,
} from "./ChatMessage";
import { Composer, Kbd } from "./Composer";
import { ConfigSelect } from "./ConfigSelect";
import { ModelSelector } from "./ModelSelector";
import { PermissionView } from "./PermissionView";
import { usePreferences } from "./PreferencesProvider";
import { SlashCommandPalette } from "./SlashCommandPalette";

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
  /** The workspace's chat store — owned by SessionView so siblings (e.g. the
   *  changes panel's review flow) can send messages and read turn state. */
  chat: ChatStore;
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
  chat,
  onRenamed,
  pendingAction,
  onActionConsumed,
  onManageModels,
}: Props) {
  const { prefs, setWorkspacePref } = usePreferences();
  const { todos } = useTodos(workspace.id);
  const {
    attachments,
    handlePaste,
    addFiles,
    remove: removeAttachment,
    clear: clearAttachments,
  } = useClipboardImages();

  const [input, setInput] = useState(
    prefs.workspace[workspace.id]?.inputText ?? "",
  );
  const [slashIndex, setSlashIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Stick-to-bottom: follow the stream only while the user IS at the bottom.
  // Scrolling up detaches (reading history isn't yanked back down); scrolling
  // back to the bottom re-attaches. Sending a message always re-attaches.
  const atBottom = useRef(true);
  const nameRequested = useRef(false);

  const trackScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
  }, []);

  // Auto-scroll to the newest content — only while attached to the bottom.
  useEffect(() => {
    if (atBottom.current)
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat.entries]);

  // A freshly opened workspace always starts attached at the bottom.
  useEffect(() => {
    atBottom.current = true;
  }, [workspace.id]);

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

  // Reasoning effort ("thinking level") needs no special handling here:
  // opencode advertises it over ACP as a dynamic `effort` config option
  // (category thoughtLevel) once a variant-capable model is selected, so the
  // generic config map below renders it like mode — see chat.config.map.

  async function send() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || chat.busy) return;
    const origin = text.startsWith("/") ? "slash" : "user";
    // Sending re-attaches the transcript to the bottom.
    atBottom.current = true;

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
      <div
        ref={scrollRef}
        onScroll={trackScroll}
        className="flex-1 overflow-y-auto"
      >
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
              return <UserMessageView key={entry.entryId} entry={entry} />;
            if (entry.type === "assistant")
              return (
                <MessageShell key={entry.entryId} role="assistant">
                  <AssistantTurnView entry={entry} />
                </MessageShell>
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
        <ActiveTodoStrip todos={todos} busy={chat.busy} />
        <Composer
          value={input}
          onChange={setInput}
          onBlur={() => saveDraft(input)}
          onPaste={handlePaste}
          placeholder="Ask the agent…"
          hint={
            <>
              <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd> <Kbd>Enter</Kbd> new
              line · <Kbd>/</Kbd> commands · paste images to attach
            </>
          }
          controls={chat.config.map((o) =>
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
          attachments={attachments}
          onRemoveAttachment={removeAttachment}
          onAttachFiles={addFiles}
          busy={chat.busy}
          canSend={!!input.trim() || attachments.length > 0}
          onSend={() => void send()}
          onStop={chat.abort}
          context={chat.context}
          onKeyDown={(e) => {
            // The slash palette captures Enter/Tab first.
            if (showPalette && slashMatches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIndex((i) => (i + 1) % slashMatches.length);
                return;
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIndex(
                  (i) => (i - 1 + slashMatches.length) % slashMatches.length,
                );
                return;
              } else if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickCommand(slashMatches[slashIndex].name);
                return;
              } else if (e.key === "Escape") {
                e.preventDefault();
                setInput("");
                return;
              }
            }
            // Enter sends; Shift/⌘/Ctrl+Enter inserts a newline.
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              void send();
              return;
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              // Textareas don't insert a newline on ⌘/Ctrl+Enter natively —
              // do it by hand so the modifier means "literal newline".
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart ?? input.length;
              const end = el.selectionEnd ?? input.length;
              const next = input.slice(0, start) + "\n" + input.slice(end);
              setInput(next);
              requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = start + 1;
              });
            }
          }}
        />
      </div>
    </div>
  );
}

