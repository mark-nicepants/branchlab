import type { ContextInfo } from "../lib/types";
import { cn } from "@/lib/utils";

const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * Context-window usage ring for the composer rail. Quiet ring below 75%;
 * from 75% the percent appears and the ring turns warning, destructive from
 * 90% — the number showing up is itself the signal.
 */
export function ContextRing({ info }: { info: ContextInfo | null }) {
  // Always visible in a session — before the first report it's an empty ring.
  const known = info !== null && info.max > 0;
  const pct = known
    ? Math.min(100, Math.round((info.used / info.max) * 100))
    : 0;
  const tone =
    pct >= 90
      ? "text-destructive"
      : pct >= 75
        ? "text-warning"
        : "text-primary";

  return (
    <span
      className="flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent"
      title={
        known
          ? `Context window · ${fmtTokens(info.used)} / ${fmtTokens(info.max)} tokens (${pct}%)`
          : "Context window · no usage reported yet"
      }
    >
      <svg width="18" height="18" viewBox="0 0 20 20" className="-rotate-90">
        <circle
          cx="10"
          cy="10"
          r={RADIUS}
          fill="none"
          strokeWidth="2.5"
          className="stroke-border"
        />
        <circle
          cx="10"
          cy="10"
          r={RADIUS}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - pct / 100)}
          className={cn("stroke-current transition-all duration-300", tone)}
        />
      </svg>
      {pct >= 75 && (
        <span className={cn("font-mono text-[11px] tabular-nums", tone)}>
          {pct}%
        </span>
      )}
    </span>
  );
}
