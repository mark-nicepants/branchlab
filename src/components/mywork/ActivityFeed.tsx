// The task dialog's activity timeline: recorded events rendered as
// Linear-style sentences, comment/command bubbles, and the composer that
// posts them. Fetched on open and refetched on every `tasks:changed`.
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Circle,
  CircleCheck,
  Loader2,
  MessageSquare,
  Paperclip,
  Play,
  Sparkles,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { taskActivity, taskComment } from "../../lib/api";
import { onTasksChanged } from "../../lib/events";
import type { ActivityEntry, Task } from "../../lib/types";
import { REVIEW_TEXT } from "./TaskCard";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/** Feed timestamp: time-of-day for today, short date otherwise. */
function formatWhen(ts: number): string {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Event glyph, colored by actor (user muted, agent green, ai primary) with
 *  kind overrides (review purple, done green). */
function ActivityIcon({ kind, actor }: { kind: string; actor: string }) {
  const color =
    kind === "review"
      ? REVIEW_TEXT
      : kind === "done"
        ? "text-additions"
        : actor === "ai"
          ? "text-primary"
          : actor === "agent"
            ? "text-additions"
            : "text-muted-foreground";
  const Icon =
    kind === "plan"
      ? Sparkles
      : kind === "session"
        ? Play
        : kind === "review" || kind === "done"
          ? CircleCheck
          : kind === "resumed"
            ? Undo2
            : kind === "moved"
              ? ArrowRight
              : kind === "attached" || kind === "detached"
                ? Paperclip
                : Circle; // created + unknown kinds
  return (
    // Opaque backing so the icon masks the timeline's vertical line.
    <span className="relative flex size-[15px] shrink-0 items-center justify-center rounded-full bg-popover">
      <Icon className={cn("size-3.5", color)} />
    </span>
  );
}

/** Linear-style actor name that opens each feed sentence. */
function actorName(actor: string): string {
  return actor === "user"
    ? "You"
    : actor === "agent"
      ? "Agent"
      : actor === "ai"
        ? "AI"
        : "System";
}

/** The slightly-emphasized actor prefix of a feed sentence. */
function Actor({ actor }: { actor: string }) {
  return (
    <span className="font-medium text-foreground/90">{actorName(actor)}</span>
  );
}

/** One actor-prefixed sentence per recorded event kind ("You created the
 *  task" — the row itself renders muted, the actor pops). */
function activityText(entry: ActivityEntry): React.ReactNode {
  const actor = <Actor actor={entry.actor} />;
  switch (entry.kind) {
    case "created":
      return <>{actor} created the task</>;
    case "plan":
      // The body reads like a predicate ("planned 2 subtasks").
      return (
        <>
          {actor} {entry.body || "planned subtasks"}
        </>
      );
    case "session":
      return "Session started";
    case "review":
      return (
        <>
          {actor} finished a turn — moved to{" "}
          <span className={REVIEW_TEXT}>Needs review</span>
        </>
      );
    case "resumed":
      return <>{actor} resumed — back to In progress</>;
    case "moved":
      // The body may carry a suffix ("In progress — queued 3 subtasks").
      return (
        <>
          {actor} moved it to {entry.body}
        </>
      );
    case "turn":
      return entry.body; // already starts with a verb (the AI summary)
    case "done":
      return entry.body === "PR merged" ? (
        "PR merged — moved to Done"
      ) : entry.body ? (
        <>
          {actor} — {entry.body}
        </>
      ) : (
        <>{actor} moved it to Done</>
      );
    case "attached":
      return (
        <>
          {actor} attached {entry.body}
        </>
      );
    case "detached":
      return (
        <>
          {actor} removed {entry.body}
        </>
      );
    default:
      return entry.body;
  }
}

/** The task's timeline (thin vertical line): event rows, comment bubbles, and
 *  the comment/command composer. Fetched on open, refetched on every
 *  `tasks:changed` while the dialog is up. */
export function ActivityFeed({
  task,
  composerRef,
}: {
  task: Task;
  /** The dialog's `/` shortcut focuses (and seeds) the composer through this. */
  composerRef?: React.RefObject<{ focusSlash: () => void } | null>;
}) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef<number | null>(null);

  useEffect(() => {
    if (!composerRef) return;
    composerRef.current = {
      focusSlash: () => {
        inputRef.current?.focus();
        // Seed the slash so the command hint shows (the keydown itself was
        // preventDefault-ed to avoid typing it twice).
        setDraft((d) => (d === "" ? "/" : d));
      },
    };
  }, [composerRef]);

  useEffect(() => {
    let live = true;
    const refetch = () =>
      void taskActivity(task.id).then((a) => live && setEntries(a));
    refetch();
    // Fresh closure per mount (see the board subscription note above).
    const unlisten = onTasksChanged(() => refetch());
    return () => {
      live = false;
      void unlisten.then((f) => f());
    };
  }, [task.id]);

  // Auto-scroll to the newest entry — but never on the initial load, so
  // opening the dialog doesn't jump past the description.
  useEffect(() => {
    if (prevCount.current !== null && entries.length > prevCount.current)
      bottomRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    prevCount.current = entries.length;
  }, [entries.length]);

  const submit = () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    taskComment(task.id, body)
      .then(() => {
        setDraft("");
        return taskActivity(task.id).then(setEntries);
      })
      // Keep the draft on failure so a mistyped /command can be fixed.
      .catch((e) => toast.error(String(e)))
      .finally(() => setSending(false));
  };

  return (
    <div className="flex flex-col">
      <div className="pb-2.5 text-xs font-medium tracking-wide text-muted-foreground">
        ACTIVITY
      </div>
      <div className="relative flex flex-col">
        <div className="absolute bottom-3 left-[7px] top-2 w-px bg-border/70" />

        {entries.map((entry) =>
          entry.kind === "comment" || entry.kind === "command" ? (
            <div key={entry.id} className="relative flex gap-3 py-2">
              {/* Same timeline-glyph style as event rows (masks the line). */}
              <span className="relative mt-1.5 flex size-[15px] shrink-0 items-center justify-center rounded-full bg-popover">
                <MessageSquare
                  className={cn(
                    "size-3.5",
                    entry.actor === "user"
                      ? "text-primary"
                      : "text-muted-foreground",
                  )}
                />
              </span>
              <div className="min-w-0 flex-1 rounded-lg border border-border bg-accent/40 px-3 py-2">
                <div className="pb-1 text-[10.5px] text-muted-foreground">
                  <span className="font-medium">{actorName(entry.actor)}</span>
                  {" · "}
                  {formatWhen(entry.createdAt)}
                </div>
                {entry.kind === "command" ? (
                  <div className="font-mono text-xs leading-relaxed">
                    <span className="text-primary">
                      {entry.body.split(/\s+/, 1)[0]}
                    </span>
                    {entry.body.slice(entry.body.split(/\s+/, 1)[0].length)}
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap text-xs leading-relaxed">
                    {entry.body}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div
              key={entry.id}
              className="relative flex items-center gap-3 py-1 text-xs text-muted-foreground"
            >
              <ActivityIcon kind={entry.kind} actor={entry.actor} />
              <span className="min-w-0 flex-1">{activityText(entry)}</span>
              <span className="shrink-0 text-[10.5px] text-muted-foreground/60">
                {formatWhen(entry.createdAt)}
              </span>
            </div>
          ),
        )}
        <div ref={bottomRef} />

        {/* Composer */}
        <div className="relative flex gap-3 pt-2.5">
          <span className="relative mt-2 flex size-[15px] shrink-0 items-center justify-center rounded-full bg-popover">
            <MessageSquare className="size-3.5 text-primary" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 transition-colors focus-within:border-ring">
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter and ⌘Enter both submit.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="Leave a comment — / for commands…"
                className="min-w-0 flex-1 bg-transparent py-1 text-xs outline-none placeholder:text-muted-foreground"
              />
              {sending ? (
                <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <Kbd>⌘↵</Kbd>
              )}
            </div>
            {draft.startsWith("/") && (
              <p className="pt-1 text-[10.5px] text-muted-foreground">
                /start [instructions] · /send &lt;message&gt; · /stop · /done
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
