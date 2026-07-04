import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Todo } from "../lib/types";
import { todoStatusBg } from "@/lib/status";
import { cn } from "@/lib/utils";

interface Props {
  todos: Todo[];
  busy: boolean;
}

/**
 * The agent's current todo, docked above the composer while a turn runs.
 * Replaces the old TodoButton popover: clicking the strip expands the full
 * todo list in place. When the active todo changes, the old line slides out
 * to the top and the new one slides in from the bottom. Busy with no todos
 * shows nothing — the composer's border sweep already signals activity.
 */
export function ActiveTodoStrip({ todos, busy }: Props) {
  const active =
    todos.find((t) => t.status === "in_progress") ??
    todos.find((t) => t.status === "pending");
  const [expanded, setExpanded] = useState(false);
  // Previous todo text, kept around briefly for the slide-out animation.
  const [prev, setPrev] = useState<string | null>(null);
  const lastContent = useRef<string | null>(null);

  useEffect(() => {
    if (!active) {
      lastContent.current = null;
      return;
    }
    if (lastContent.current && lastContent.current !== active.content) {
      setPrev(lastContent.current);
      const t = setTimeout(() => setPrev(null), 220);
      lastContent.current = active.content;
      return () => clearTimeout(t);
    }
    lastContent.current = active.content;
  }, [active?.content]);

  // Collapse when the strip disappears so the next run starts collapsed.
  useEffect(() => {
    if (!busy) setExpanded(false);
  }, [busy]);

  if (!busy || !active) return null;
  const position = todos.indexOf(active) + 1;

  return (
    <div className="mx-auto mb-2 max-w-4xl animate-in fade-in slide-in-from-bottom-1 duration-200">
      <div className="overflow-hidden rounded-lg border border-primary/25 bg-primary/5">
        {expanded && (
          <ul className="max-h-[40vh] space-y-1 overflow-y-auto border-b border-primary/15 p-2">
            {todos.map((todo, i) => (
              <li
                key={i}
                className={cn(
                  "flex items-start gap-2 rounded px-2 py-1 text-xs",
                  todo.status === "completed" &&
                    "text-muted-foreground line-through",
                  todo.status === "in_progress" &&
                    "bg-accent text-accent-foreground",
                  todo.status === "pending" && "text-foreground",
                  todo.status === "cancelled" &&
                    "text-destructive line-through",
                )}
              >
                <span
                  className={cn(
                    "mt-1 block size-1.5 shrink-0 rounded-full",
                    todoStatusBg(todo.status),
                  )}
                />
                <span className="flex-1">{todo.content}</span>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs hover:bg-primary/10"
          title={expanded ? "Hide todo list" : "Show todo list"}
        >
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-primary">
            Todo
          </span>
          <span className="relative min-w-0 flex-1 overflow-hidden">
            {prev && (
              <span className="absolute inset-0 animate-out fade-out slide-out-to-top-2 truncate fill-mode-forwards duration-200">
                {prev}
              </span>
            )}
            <span
              key={active.content}
              className={cn(
                "block truncate",
                prev &&
                  "animate-in fade-in slide-in-from-bottom-2 duration-200",
              )}
            >
              {active.content}
            </span>
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {position} of {todos.length}
          </span>
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
      </div>
    </div>
  );
}
