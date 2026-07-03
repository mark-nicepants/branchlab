import { CheckCircle2, GitPullRequest, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import type {
  AutofixMode,
  PipelinePhase,
  PrCheck,
  PrStatus,
} from "../../lib/types";

interface Props {
  status: PrStatus | null;
  phase: PipelinePhase;
  attempts: number;
  mode: AutofixMode;
  onModeChange: (mode: AutofixMode) => void;
}

const MODES: { value: AutofixMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Only monitor the pipeline" },
  {
    value: "auto",
    label: "Autofix",
    hint: "On failure, the AI fixes locally — you push to re-run",
  },
  {
    value: "super",
    label: "Superfix",
    hint: "On failure, the AI fixes, commits, and pushes until green",
  },
];

/** Colored icon for a coarse check bucket. */
function BucketIcon({ bucket, className }: { bucket: string; className?: string }) {
  if (bucket === "success")
    return (
      <CheckCircle2
        className={cn("text-emerald-600 dark:text-emerald-500", className)}
      />
    );
  if (bucket === "failure")
    return <TriangleAlert className={cn("text-destructive", className)} />;
  if (bucket === "skipped")
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  return <Loader2 className={cn("animate-spin text-warning", className)} />;
}

/** Summary line for the rollup, e.g. "2 checks failing". */
function summary(status: PrStatus): string {
  const total = status.checks.length;
  switch (status.rollup) {
    case "success":
      return `All ${total} checks passing`;
    case "pending": {
      const running = status.checks.filter((c) => c.bucket === "pending").length;
      return `${running} of ${total} checks running`;
    }
    case "failure": {
      const failing = status.checks.filter((c) => c.bucket === "failure").length;
      return `${failing} of ${total} checks failing`;
    }
    default:
      return "No checks";
  }
}

/** Contextual note for the current loop phase. */
function phaseNote(
  phase: PipelinePhase,
  mode: AutofixMode,
  attempts: number,
): { text: string; spin?: boolean; tone: "muted" | "warning" | "destructive" } | null {
  switch (phase) {
    case "fixing":
      return {
        text: mode === "super" ? "Superfixing…" : "Autofixing…",
        spin: true,
        tone: "warning",
      };
    case "awaiting_push":
      return {
        text: "Fixed & committed — push to re-run the pipeline",
        tone: "warning",
      };
    case "exhausted":
      return {
        text: `Superfix stopped after ${attempts} attempts`,
        tone: "destructive",
      };
    default:
      return null;
  }
}

/**
 * A slim bar above the chat showing the PR's CI pipeline status, with a
 * three-way Off / Autofix / Superfix control. Renders nothing until a PR
 * exists for the branch. The autofix/superfix loop itself lives in
 * usePrPipeline; this component is purely presentational.
 */
export function PrPipeline({ status, phase, attempts, mode, onModeChange }: Props) {
  if (!status) return null;

  const note = phaseNote(phase, mode, attempts);

  return (
    <div className="flex items-center gap-2 border-b border-border bg-card/40 px-3 py-1.5 text-xs">
      <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
      <a
        href={status.url}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 font-medium text-foreground hover:underline"
      >
        #{status.number}
      </a>

      <HoverCard openDelay={120}>
        <HoverCardTrigger className="flex min-w-0 items-center gap-1.5">
          <BucketIcon bucket={status.rollup} className="size-3.5 shrink-0" />
          <span className="truncate text-muted-foreground">{summary(status)}</span>
        </HoverCardTrigger>
        <HoverCardContent side="bottom" align="start" className="w-72 p-2">
          <div className="mb-1 px-1 text-[11px] font-medium text-muted-foreground">
            Checks
          </div>
          <ul className="flex flex-col">
            {status.checks.length === 0 && (
              <li className="px-1 py-1 text-muted-foreground">No checks reported.</li>
            )}
            {status.checks.map((c: PrCheck) => (
              <li key={`${c.workflow ?? ""}/${c.name}`}>
                <a
                  href={c.url ?? status.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded px-1 py-1 hover:bg-accent"
                >
                  <BucketIcon bucket={c.bucket} className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {c.workflow && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {c.workflow}
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </HoverCardContent>
      </HoverCard>

      {note && (
        <span
          className={cn(
            "flex min-w-0 items-center gap-1 truncate",
            note.tone === "warning" && "text-warning",
            note.tone === "destructive" && "text-destructive",
            note.tone === "muted" && "text-muted-foreground",
          )}
        >
          {note.spin && <Loader2 className="size-3 shrink-0 animate-spin" />}
          {note.text}
        </span>
      )}

      {/* Three-way autofix control */}
      <div className="ml-auto flex shrink-0 items-center rounded-md border border-border p-0.5">
        {MODES.map((m) => {
          const active = mode === m.value;
          return (
            <button
              key={m.value}
              type="button"
              title={m.hint}
              onClick={() => onModeChange(m.value)}
              className={cn(
                "flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m.value === "super" && <Sparkles className="size-3" />}
              {m.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
