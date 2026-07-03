import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  CircleDashed,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import type { CiRollup } from "../../lib/types";

/** Colored icon for a coarse CI rollup/bucket — the shared visual language for
 *  PR status across the pipeline bar and the review inbox. */
export function CiIcon({
  rollup,
  className,
}: {
  rollup: CiRollup | "skipped";
  className?: string;
}) {
  switch (rollup) {
    case "success":
      return (
        <CheckCircle2
          className={cn("text-emerald-600 dark:text-emerald-500", className)}
        />
      );
    case "failure":
      return <TriangleAlert className={cn("text-destructive", className)} />;
    case "pending":
      return <Loader2 className={cn("animate-spin text-warning", className)} />;
    default:
      return (
        <CircleDashed className={cn("text-muted-foreground/60", className)} />
      );
  }
}
