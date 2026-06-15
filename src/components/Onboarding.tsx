import { Check, X } from "lucide-react";
import type { EnvReport, ToolStatus } from "../lib/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  env: EnvReport;
  onRecheck: () => void;
  rechecking: boolean;
}

/**
 * Shown when a required external tool is missing. OpenScope does not bundle
 * `opencode` in the MVP, so we guide the user to install it.
 */
export function Onboarding({ env, onRecheck, rechecking }: Props) {
  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-8">
        <h1 className="text-xl font-semibold">Welcome to OpenScope</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          OpenScope drives the <code className="rounded bg-muted px-1">opencode</code> CLI and uses{" "}
          <code className="rounded bg-muted px-1">git</code> for worktrees. Let's make sure both are
          installed.
        </p>

        <ul className="my-6 flex flex-col gap-2.5">
          <ToolRow name="opencode" status={env.opencode} hint="curl -fsSL https://opencode.ai/install | bash" />
          <ToolRow name="git" status={env.git} hint="xcode-select --install   (macOS)" />
        </ul>

        <Button onClick={onRecheck} disabled={rechecking}>
          {rechecking ? "Checking…" : "Re-check"}
        </Button>
      </div>
    </div>
  );
}

function ToolRow({ name, status, hint }: { name: string; status: ToolStatus; hint: string }) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
      <span className={cn("mt-0.5", status.found ? "text-primary" : "text-destructive")}>
        {status.found ? <Check className="size-4" /> : <X className="size-4" />}
      </span>
      <div className="min-w-0">
        <div className="font-medium">{name}</div>
        {status.found ? (
          <div className="truncate text-xs text-muted-foreground">
            {status.version ?? "found"} · <code className="rounded bg-muted px-1">{status.path}</code>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            Not found on PATH. Install with: <code className="rounded bg-muted px-1">{hint}</code>
          </div>
        )}
      </div>
    </li>
  );
}
