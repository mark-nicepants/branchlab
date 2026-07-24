import { useEffect, useState } from "react";
import { onWorkspaceTodos } from "../lib/events";
import type { Todo } from "../lib/types";

/**
 * Track the workspace's todo list from backend `workspace:todos` pushes (the
 * supervisor polls OpenCode centrally — no per-client polling here).
 */
export function useTodos(workspaceId: string) {
  const [todos, setTodos] = useState<Todo[]>([]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onWorkspaceTodos((p) => {
      if (p.workspaceId === workspaceId) setTodos(p.todos);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [workspaceId]);

  return { todos };
}
