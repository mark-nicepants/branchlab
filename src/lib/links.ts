// Global link handling.
//
// BranchLab runs inside a single Tauri webview. If any <a> is allowed to
// navigate, it replaces the whole document — i.e. the entire app UI is gone
// with no way back. So we NEVER let a link navigate in place: every external
// link is handed to the OS (or a real new browser tab under the browser
// harness) and the in-page navigation is cancelled.

/** Protocols we treat as "external" and hand off to the OS / a new tab. */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Open a URL outside the current webview. Uses the Tauri opener (OS default
 * handler) when running as the desktop app, and falls back to a new browser
 * tab under `dev:browser`. Never navigates the current document.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch (err) {
      console.error("Failed to open link externally:", url, err);
      return;
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Install a single capture-phase click listener that intercepts every anchor
 * click in the app. Any link to an external protocol is opened out-of-process;
 * the default in-place navigation is always prevented. Call once at startup.
 */
export function installGlobalLinkCatcher(): void {
  document.addEventListener(
    "click",
    (event) => {
      // Respect other handlers that already dealt with the event.
      if (event.defaultPrevented) return;
      // Only plain left-clicks; let modifier/middle clicks fall through to the
      // browser (which, in the desktop webview, still can't navigate away).
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey)
        return;

      const anchor = (event.target as HTMLElement | null)?.closest("a");
      const href = anchor?.getAttribute("href");
      if (!anchor || !href) return;

      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return; // Not a resolvable URL (e.g. a bare "#") — leave it alone.
      }

      if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return;

      // The one job: never let this navigate the app away.
      event.preventDefault();
      void openExternal(url.href);
    },
    { capture: true },
  );
}
