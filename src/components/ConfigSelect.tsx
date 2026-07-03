import { ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ConfigOption } from "../lib/types";

interface Props {
  option: ConfigOption;
  onChange: (value: string) => void;
}

/**
 * A single session config selector (model / reasoning level / mode), driven
 * entirely by an ACP-advertised `ConfigOption`. Replaces the old bespoke
 * Model/Mode/Thinking selectors — the agent tells us what's selectable.
 */
export function ConfigSelect({ option, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const current = option.choices.find((c) => c.value === option.currentValue);
  if (option.choices.length === 0) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
          title={option.name}
        >
          <span className="max-w-[160px] truncate">
            {current?.name ?? option.currentValue ?? option.name}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="max-h-[50vh] min-w-[160px] overflow-y-auto"
      >
        <DropdownMenuRadioGroup
          value={option.currentValue}
          onValueChange={(v) => {
            onChange(v);
            setOpen(false);
          }}
        >
          {option.choices.map((c) => (
            <DropdownMenuRadioItem key={c.value} value={c.value}>
              <span className="flex flex-1 items-center">{c.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
