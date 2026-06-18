import { cn } from "@/lib/utils";

/**
 * Underline-style tab bar item. Use inside a parent row with `border-b` so the
 * active item's underline sits flush. Two sizes: default ("md", text-sm) for
 * the main content area, "sm" (text-xs) for popovers.
 */
export function TabBarItem({
  active,
  onClick,
  size = "md",
  children,
}: {
  active: boolean;
  onClick: () => void;
  size?: "sm" | "md";
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "border-b-2 px-2",
        size === "md" ? "py-2.5 text-sm" : "py-2 text-xs",
        active
          ? "border-primary font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
