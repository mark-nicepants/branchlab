import { useEffect, useRef } from "react";

export interface ShortcutHandlers {
  toggleLeft: () => void;
  toggleRight: () => void;
  openSettings: () => void;
  openInspector: () => void;
  newProject: () => void;
  goHome: () => void;
  goTasks: () => void;
}

/**
 * Global keyboard shortcuts (Cmd/Ctrl based):
 *   ⌘B  toggle left panel      ⌘D  toggle right panel
 *   ⌘,  settings               ⌘⌥I inspector
 *   ⌘N  new project
 *   ⌘H  home                   ⌘T  my work (tasks)
 * Handlers are kept in a ref so the listener registers once but always calls
 * the latest callbacks.
 */
export function useShortcuts(handlers: ShortcutHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      const h = ref.current;
      if (k === "b") {
        e.preventDefault();
        h.toggleLeft();
      } else if (k === "d") {
        e.preventDefault();
        h.toggleRight();
      } else if (k === ",") {
        e.preventDefault();
        h.openSettings();
      } else if (k === "i" && e.altKey) {
        e.preventDefault();
        h.openInspector();
      } else if (k === "n") {
        e.preventDefault();
        h.newProject();
      } else if (k === "h") {
        // macOS may claim ⌘H for "Hide" via the app menu; when the event does
        // reach the webview, it navigates home.
        e.preventDefault();
        h.goHome();
      } else if (k === "t") {
        e.preventDefault();
        h.goTasks();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
