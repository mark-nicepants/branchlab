import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import type { AgentOption } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

interface Props {
  agents: AgentOption[];
  value: AgentOption | null;
  onChange: (agent: AgentOption) => void;
}

/** User-facing primary agent modes, shown in the order we prefer them. */
const PRIORITY = ["build", "plan", "ask", "summary"];

/** Sort primary agents: preferred order first, then alphabetically. */
function sortAgents(agents: AgentOption[]): AgentOption[] {
  return [...agents].sort((a, b) => {
    const ai = PRIORITY.indexOf(a.name);
    const bi = PRIORITY.indexOf(b.name);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Agent / mode picker for the chat composer. Lists only the primary, user-
 * facing OpenCode agents (e.g. build, plan, ask). Subagents like `title` are
 * filtered out because they are not chat modes.
 */
export function ModeSelector({ agents, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const modes = useMemo(
    () => sortAgents(agents.filter((a) => a.mode === "primary" && a.name !== "title")),
    [agents],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 max-w-[140px] gap-1.5 px-2 text-xs font-normal text-muted-foreground"
        >
          <span className="truncate capitalize">{value ? value.name : "default"}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-[180px] p-0">
        <Command>
          <CommandInput placeholder="Search modes" className="h-9" />
          <CommandList>
            <CommandEmpty>No modes found.</CommandEmpty>
            <CommandGroup>
              {modes.map((a) => (
                <CommandItem
                  key={a.name}
                  value={a.name}
                  onSelect={() => {
                    onChange(a);
                    setOpen(false);
                  }}
                >
                  <span className="flex-1 capitalize">{a.name}</span>
                  {value?.name === a.name && <Check className="size-4" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
