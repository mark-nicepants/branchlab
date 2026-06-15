import { useEffect } from "react";

/**
 * Native-app behaviors: suppress the browser context menu everywhere (the
 * inspector is reachable via ⌘⌥I instead). Text selection is disabled globally
 * in CSS and re-enabled per element via the `select-text` utility.
 */
export function useDesktopBehaviors() {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);
}
