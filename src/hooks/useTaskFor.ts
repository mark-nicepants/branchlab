// The board task linked to a workspace (or null). Seeds from the snapshot and
// stays live via tasks:changed — light enough to mount per session view.
import { useEffect, useState } from "react";
import { boardSnapshot } from "../lib/api";
import { onTasksChanged } from "../lib/events";
import type { Task } from "../lib/types";

export function useTaskFor(workspaceId: string): Task | null {
  const [task, setTask] = useState<Task | null>(null);
  useEffect(() => {
    let live = true;
    const pick = (tasks: Task[]) =>
      tasks.find((t) => t.workspaceId === workspaceId) ?? null;
    // Passive seed: on failure the chip stays hidden until tasks:changed.
    void boardSnapshot()
      .then((s) => live && setTask(pick(s.tasks)))
      .catch(() => {});
    const unlisten = onTasksChanged((s) => setTask(pick(s.tasks)));
    return () => {
      live = false;
      void unlisten.then((f) => f());
    };
  }, [workspaceId]);
  return task;
}
