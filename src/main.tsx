import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ThemeProvider } from "@/components/ThemeProvider";
import { PreferencesProvider } from "@/components/PreferencesProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { installGlobalLinkCatcher } from "@/lib/links";
import "./index.css";

// Never let a link navigate the single app webview — it would replace the
// entire BranchLab UI. Route every external link out-of-process instead.
installGlobalLinkCatcher();

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

// The window starts hidden (tauri.conf.json) to avoid a white flash; reveal it
// once the first frame has painted.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    getCurrentWindow()
      .show()
      .catch(() => {});
  }),
);
