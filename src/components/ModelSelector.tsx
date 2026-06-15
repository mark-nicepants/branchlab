import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, SlidersHorizontal } from "lucide-react";
import type { ModelOption } from "../lib/types";
import { usePreferences } from "./PreferencesProvider";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface Props {
  models: ModelOption[];
  value: ModelOption | null;
  onChange: (model: ModelOption) => void;
}

/** Group models by provider display name, preserving the input order. */
function groupByProvider(models: ModelOption[]): [string, ModelOption[]][] {
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) {
    const list = groups.get(m.providerName) ?? [];
    list.push(m);
    groups.set(m.providerName, list);
  }
  return [...groups.entries()];
}

/**
 * Model picker styled after OpenCode desktop: a searchable, provider-grouped
 * popover, plus a "Manage models" dialog to choose which models appear (stored
 * in preferences as a hidden-key list).
 */
export function ModelSelector({ models, value, onChange }: Props) {
  const { prefs } = usePreferences();
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const disabled = useMemo(() => new Set(prefs.disabledModels), [prefs.disabledModels]);
  const visible = useMemo(() => models.filter((m) => !disabled.has(m.key)), [models, disabled]);
  const groups = useMemo(() => groupByProvider(visible), [visible]);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 max-w-[280px] gap-1.5 px-2 text-xs font-normal text-muted-foreground"
          >
            <span className="truncate">{value ? value.name : "default model"}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-[300px] p-0">
          <Command>
            <div className="flex items-center gap-1 border-b border-border pr-1.5">
              <CommandInput placeholder="Search models" className="h-9" />
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground"
                title="Manage models"
                onClick={() => {
                  setOpen(false);
                  setManageOpen(true);
                }}
              >
                <SlidersHorizontal className="size-3.5" />
              </Button>
            </div>
            <CommandList>
              <CommandEmpty>No models found.</CommandEmpty>
              {groups.map(([provider, list]) => (
                <CommandGroup key={provider} heading={provider}>
                  {list.map((m) => (
                    <CommandItem
                      key={m.key}
                      value={`${m.providerName} ${m.name} ${m.key}`}
                      onSelect={() => {
                        onChange(m);
                        setOpen(false);
                      }}
                    >
                      <span className="flex-1 truncate">{m.name}</span>
                      {value?.key === m.key && <Check className="size-4" />}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <ManageModelsDialog open={manageOpen} onOpenChange={setManageOpen} models={models} />
    </>
  );
}

function ManageModelsDialog({
  open,
  onOpenChange,
  models,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  models: ModelOption[];
}) {
  const { prefs, setPref } = usePreferences();
  const [query, setQuery] = useState("");

  const disabled = useMemo(() => new Set(prefs.disabledModels), [prefs.disabledModels]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.name.toLowerCase().includes(q) || m.providerName.toLowerCase().includes(q),
    );
  }, [models, query]);
  const groups = useMemo(() => groupByProvider(filtered), [filtered]);

  function toggle(key: string, enabled: boolean) {
    const next = new Set(prefs.disabledModels);
    if (enabled) next.delete(key);
    else next.add(key);
    setPref("disabledModels", [...next]);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage models</DialogTitle>
          <DialogDescription>Customize which models appear in the model selector.</DialogDescription>
        </DialogHeader>

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models"
          className="h-9"
        />

        <div className="-mr-2 max-h-[55vh] overflow-y-auto pr-2">
          {groups.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No models found.</p>
          )}
          {groups.map(([provider, list]) => (
            <div key={provider} className="mb-2">
              <div className="px-1 py-1.5 text-xs font-medium text-muted-foreground">{provider}</div>
              {list.map((m) => (
                <label
                  key={m.key}
                  className={cn(
                    "flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                  )}
                >
                  <span className="truncate">{m.name}</span>
                  <Switch
                    checked={!disabled.has(m.key)}
                    onCheckedChange={(v) => toggle(m.key, v)}
                  />
                </label>
              ))}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
