import type { ReactNode } from "react";

/** A boxed keystroke for hint lines (composer hints, shortcut lists). */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-b-2 border-border bg-card px-1 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}
