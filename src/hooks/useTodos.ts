import { useCallback, useEffect, useState } from "react";
import { chatTodos } from "../lib/api";
import { listenAll, onWorkspaceTodos } from "../lib/events";
import type { Todo } from "../lib/types";

/** Equal when content+status match in order. */
function sameTodoList(a: Todo[], b: Todo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].content !== b[i].content || a[i].status !== b[i].status)
      return false;
  }
  return true;
}

/**
 * Track the workspace's todo list from backend `workspace:todos` pushes (the
 * supervisor polls OpenCode centrally — no per-client polling here). When the
 * user dismisses an all-completed list (by starting a new turn), this hook
 * hides that exact list until the assistant produces a different one.
 */
export function useTodos(workspaceId: string) {
  const [todos, setTodos] = useState<Todo[]>([]);
  // The setter is used inside its own callback; the value is read inside the callback.
  const [, setDismissedTodos] = useState<Todo[] | null>(null);

  const apply = useCallback((list: Todo[]) => {
    setDismissedTodos((dismissed) => {
      if (dismissed && sameTodoList(list, dismissed)) {
        setTodos([]);
        return dismissed;
      }
      setTodos(list);
      return null;
    });
  }, []);

  useEffect(() => {
    setTodos([]);
    let eventArrived = false;
    const subs = listenAll(
      onWorkspaceTodos((p) => {
        if (p.workspaceId === workspaceId) {
          eventArrived = true;
          apply(p.todos);
        }
      }),
    );
    // Seed after the listener is live (events aren't buffered) so switching
    // to a workspace mid-turn shows its current list, not an empty strip.
    // A pushed event is always newer than the snapshot — it wins.
    void subs.ready.then((live) => {
      if (!live) return;
      chatTodos(workspaceId)
        .then((list) => {
          if (!subs.disposed && !eventArrived && list.length > 0) apply(list);
        })
        .catch(() => {}); // seed only — an empty strip is an acceptable fallback
    });
    return subs.dispose;
  }, [workspaceId, apply]);

  /** Call when the user starts a new turn while every todo is `completed`. */
  const dismissIfAllCompleted = useCallback(() => {
    setTodos((current) => {
      if (
        current.length > 0 &&
        current.every((t) => t.status === "completed")
      ) {
        setDismissedTodos(current);
        return [];
      }
      return current;
    });
  }, []);

  return { todos, dismissIfAllCompleted };
}
