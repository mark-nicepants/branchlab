// Browser dev entry point. Mirrors src/main.tsx but stubs the Tauri runtime
// and loads the mocked API module, so the UI can be opened in a browser for
// visual debugging without a running Rust backend.

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "@/components/ThemeProvider";
import { PreferencesProvider } from "@/components/PreferencesProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import "./index.css";

// Stub the Tauri internals global so @tauri-apps/api/core doesn't throw.
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
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
        <TooltipProvider delayDuration={300}>
          <App />
          <Toaster />
        </TooltipProvider>
      </PreferencesProvider>
    </ThemeProvider>
  </React.StrictMode>,
);

// No-op replacement for getCurrentWindow().show().
