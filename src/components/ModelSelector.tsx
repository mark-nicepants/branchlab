import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Search, SlidersHorizontal } from "lucide-react";
import type { ModelOption } from "../lib/types";
import { usePreferences } from "./PreferencesProvider";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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

  const disabled = useMemo(
    () => new Set(prefs.disabledModels),
    [prefs.disabledModels],
  );
  const visible = useMemo(
    () => models.filter((m) => !disabled.has(m.key)),
    [models, disabled],
  );
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
            <span className="truncate">
              {value ? value.name : "default model"}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          className="w-[320px] overflow-hidden rounded-xl p-0"
        >
          <Command>
            <CommandInput placeholder="Search models" className="h-10" />
            <CommandList className="max-h-[320px] p-1.5">
              <CommandEmpty className="py-6 text-center text-sm text-muted-foreground">
                No models found.
              </CommandEmpty>
              {groups.map(([provider, list]) => (
                <CommandGroup
                  key={provider}
                  heading={provider}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {list.map((m) => (
                    <CommandItem
                      key={m.key}
                      value={`${m.providerName} ${m.name} ${m.key}`}
                      onSelect={() => {
                        onChange(m);
                        setOpen(false);
                      }}
                      className="gap-2 rounded-md px-2 py-1.5"
                    >
                      <span className="flex-1 truncate">{m.name}</span>
                      {value?.key === m.key && (
                        <Check className="size-4 text-primary" />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
            <div className="border-t border-border p-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-full justify-start gap-2 px-2 text-xs font-normal text-muted-foreground"
                onClick={() => {
                  setOpen(false);
                  setManageOpen(true);
                }}
              >
                <SlidersHorizontal className="size-3.5" /> Manage models…
              </Button>
            </div>
          </Command>
        </PopoverContent>
      </Popover>

      <ManageModelsDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        models={models}
      />
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

  const disabled = useMemo(
    () => new Set(prefs.disabledModels),
    [prefs.disabledModels],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.providerName.toLowerCase().includes(q),
    );
  }, [models, query]);
  const groups = useMemo(() => groupByProvider(filtered), [filtered]);

  const enabledCount = filtered.filter((m) => !disabled.has(m.key)).length;
  const allEnabled = filtered.length > 0 && enabledCount === filtered.length;

  function toggle(key: string, enabled: boolean) {
    const next = new Set(prefs.disabledModels);
    if (enabled) next.delete(key);
    else next.add(key);
    setPref("disabledModels", [...next]);
  }

  /** Enable or disable every currently-filtered model at once. */
  function toggleAll() {
    const next = new Set(prefs.disabledModels);
    for (const m of filtered) {
      if (allEnabled) next.add(m.key);
      else next.delete(m.key);
    }
    setPref("disabledModels", [...next]);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] w-full max-w-lg flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="px-6 pb-4 pt-6">
          <DialogTitle>Manage models</DialogTitle>
          <DialogDescription>
            Customize which models appear in the model selector.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 border-y border-border px-6 py-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models"
              className="h-8 pl-8"
            />
          </div>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {enabledCount}/{filtered.length}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={filtered.length === 0}
            onClick={toggleAll}
          >
            {allEnabled ? "Disable all" : "Enable all"}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {groups.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No models found.
            </p>
          ) : (
            groups.map(([provider, list]) => (
              <div key={provider} className="mb-2 last:mb-0">
                <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {provider}
                </div>
                {list.map((m) => (
                  <label
                    key={m.key}
                    className={cn(
                      "flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm hover:bg-accent",
                    )}
                  >
                    <span className="min-w-0 truncate">{m.name}</span>
                    <Switch
                      checked={!disabled.has(m.key)}
                      onCheckedChange={(v) => toggle(m.key, v)}
                    />
                  </label>
                ))}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
