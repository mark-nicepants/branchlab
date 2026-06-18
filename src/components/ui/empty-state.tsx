import { cn } from "@/lib/utils";

/**
 * Centered "nothing to show" message. Default fills its container (use inside
 * a flex column for empty tabs/panels). Set `dense` for tight popovers.
 */
export function EmptyState({
  icon,
  dense,
  className,
  children,
}: {
  icon?: React.ReactNode;
  dense?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  if (dense) {
    return (
      <p className={cn("px-2 py-4 text-center text-xs text-muted-foreground", className)}>{children}</p>
    );
  }
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground",
        className,
      )}
    >
      {icon}
      <div>{children}</div>
    </div>
  );
}
