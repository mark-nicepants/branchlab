import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "@/components/ThemeProvider";
import { PreferencesProvider } from "@/components/PreferencesProvider";
import { UpdateProvider } from "@/hooks/useUpdateChecker";
import { ProjectsProvider } from "@/hooks/useProjects";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { installGlobalLinkCatcher } from "@/lib/links";
import { perfMark } from "@/lib/api";
import "./index.css";

void perfMark("js eval").catch(() => {});

// Never let a link navigate the single app webview — it would replace the
// entire BranchLab UI. Route every external link out-of-process instead.
installGlobalLinkCatcher();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <PreferencesProvider>
        <UpdateProvider>
          <TooltipProvider delayDuration={300}>
            <ProjectsProvider>
              <App />
            </ProjectsProvider>
            <Toaster />
          </TooltipProvider>
        </UpdateProvider>
      </PreferencesProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
void perfMark("render scheduled").catch(() => {});

// The window starts hidden (tauri.conf.json) to avoid a white flash; App
// reveals it on its first committed frame. NOT requestAnimationFrame: WKWebView
// doesn't run rAF while the window is hidden, so waiting on it deadlocks the
// reveal until the backend's safety-net timer fires.
