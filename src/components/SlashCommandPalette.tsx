import { useEffect, useRef } from "react";
import type { CommandOption } from "../lib/types";
import { cn } from "@/lib/utils";

interface Props {
  commands: CommandOption[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onPick: (cmd: CommandOption) => void;
}

/**
 * Autocomplete popover anchored above the composer. Stateless — the parent
 * (Chat) owns the selected index and keyboard handling, so Up/Down/Enter/Tab
 * intercept inside the textarea's keydown without focus juggling.
 */
export function SlashCommandPalette({
  commands,
  selectedIndex,
  onHover,
  onPick,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row in view when the user arrows past the fold.
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as
      HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (commands.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-md">
        No matching commands.
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="max-h-64 overflow-y-auto rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-md"
    >
      {commands.map((c, i) => (
        <button
          key={c.name}
          type="button"
          // mousedown rather than click: don't let the textarea blur first.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
          onMouseEnter={() => onHover(i)}
          className={cn(
            "flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-sm",
            i === selectedIndex
              ? "bg-accent text-accent-foreground"
              : "hover:bg-accent/50",
          )}
        >
          <span className="shrink-0 font-mono text-xs">/{c.name}</span>
          {c.description && (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {c.description}
            </span>
          )}
          {c.source === "skill" && (
            <span className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              skill
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
