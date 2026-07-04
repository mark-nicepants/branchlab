// Browser dev entry point. Mirrors src/main.tsx but stubs the Tauri runtime
// and loads the mocked API module, so the UI can be opened in a browser for
// visual debugging without a running Rust backend.

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "@/components/ThemeProvider";
import { PreferencesProvider } from "@/components/PreferencesProvider";
import { UpdateProvider } from "@/hooks/useUpdateChecker";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import "./index.css";

// Stub the Tauri internals global so @tauri-apps/api/core doesn't throw.
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    // Fake a pending update (append `?update` to the URL) so the update toast,
    // gear badge, and Settings banner can be reviewed in the browser harness.
    if (
      cmd === "plugin:updater|check" &&
      new URLSearchParams(location.search).has("update")
    ) {
      return {
        rid: 0,
        available: true,
        currentVersion: "0.1.1",
        version: "0.9.9",
        body: "Mock release notes.",
      };
    }
    // eslint-disable-next-line no-console
    console.warn(
      `Tauri invoke("${cmd}") called in browser debug mode; returning null.`,
    );
    return null;
  },
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <PreferencesProvider>
        <UpdateProvider>
          <TooltipProvider delayDuration={300}>
            <App />
            <Toaster />
          </TooltipProvider>
        </UpdateProvider>
      </PreferencesProvider>
    </ThemeProvider>
  </React.StrictMode>,
);

// No-op replacement for getCurrentWindow().show().
