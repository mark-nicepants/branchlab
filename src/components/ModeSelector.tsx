import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Props {
  value: string;
  onChange: (mode: string) => void;
}

/** The two chat modes we expose. */
const MODES = ["build", "plan"];

/**
 * Simple two-option mode picker for the chat composer. Only "build" and
 * "plan" are surfaced; the full agent list from /agent is intentionally not
 * shown here.
 */
export function ModeSelector({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
        >
          <span className="truncate capitalize">{value}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-[100px]">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => { onChange(v); setOpen(false); }}>
          {MODES.map((m) => (
            <DropdownMenuRadioItem key={m} value={m}>
              <span className="flex flex-1 items-center capitalize">{m}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
