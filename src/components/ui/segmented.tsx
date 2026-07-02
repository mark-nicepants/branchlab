import { cn } from "@/lib/utils";

/** Pill-shaped two-or-more-option toggle (Unified/Split, Project/Global, …). */
export function Segmented({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex rounded-md border border-border p-0.5", className)}
    >
      {children}
    </div>
  );
}

export function SegmentedItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded px-2 py-0.5 text-xs",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
