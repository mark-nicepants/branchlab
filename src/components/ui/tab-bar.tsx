import { cn } from "@/lib/utils";

/**
 * Underline-style tab bar item. Use inside a parent row with `border-b` so the
 * active item's underline sits flush.
 */
export function TabBarItem({
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
        "border-b-2 px-2 py-2.5 text-sm",
        active
          ? "border-primary font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
