import { useCallback, useEffect, useState } from "react";
import type { OpencodeClient } from "../lib/opencode";
import type { Todo } from "../lib/types";
import { useInterval } from "./useInterval";

/** Equal when content+status match in order. */
function sameTodoList(a: Todo[], b: Todo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].content !== b[i].content || a[i].status !== b[i].status) return false;
  }
  return true;
}

const POLL_MS = 2000;

/**
 * Poll the session's todo list. When the user dismisses an all-completed list
 * (by starting a new turn), this hook hides that exact list until the
 * assistant produces a different one — compared by content+status, in order.
 */
export function useTodos(client: OpencodeClient, sessionId: string | null) {
  const [todos, setTodos] = useState<Todo[]>([]);
  // The setter is used inside its own callback; the value is read inside the callback.
  const [, setDismissedTodos] = useState<Todo[] | null>(null);

  const fetchOnce = useCallback(() => {
    if (!sessionId) return;
    client
      .listTodos(sessionId)
      .then((list) => {
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
  }, [client, sessionId]);

  useEffect(() => {
    fetchOnce();
  }, [fetchOnce]);
  useInterval(fetchOnce, sessionId ? POLL_MS : null);

  /** Call when the user starts a new turn while every todo is `completed`. */
  const dismissIfAllCompleted = useCallback(() => {
    setTodos((current) => {
      if (current.length > 0 && current.every((t) => t.status === "completed")) {
        setDismissedTodos(current);
        return [];
      }
      return current;
    });
  }, []);

  return { todos, dismissIfAllCompleted };
}
