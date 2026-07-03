import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown, SlidersHorizontal } from "lucide-react";
import type { ConfigOption } from "../lib/types";
import { groupByProvider, shortName } from "../lib/models";
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

interface Props {
  /** The ACP `model` config option (id, currentValue, choices). */
  option: ConfigOption;
  onChange: (value: string) => void;
  /** Open the global Models settings page (replaces the old inline dialog). */
  onManageModels: () => void;
}

/**
 * Model picker styled after OpenCode desktop: a searchable, provider-grouped
 * popover. The enabled subset is stored in global preferences as a disabled-
 * value list (managed in Settings → Models). Driven by the ACP-advertised
 * `model` config option; non-model options use ConfigSelect.
 */
export function ModelSelector({ option, onChange, onManageModels }: Props) {
  const { prefs, setPref } = usePreferences();
  const [open, setOpen] = useState(false);

  // Cache the advertised catalog so the global Models settings page can render
  // the list without an open session. Update only when it actually changes.
  useEffect(() => {
    if (option.choices.length === 0) return;
    const next = option.choices.map((c) => ({
      value: c.value,
      name: c.name,
      group: c.group,
    }));
    const cur = prefs.modelCatalog;
    const same =
      cur.length === next.length &&
      cur.every((c, i) => c.value === next[i].value && c.name === next[i].name);
    if (!same) setPref("modelCatalog", next);
  }, [option.choices, prefs.modelCatalog, setPref]);

  const disabled = useMemo(
    () => new Set(prefs.disabledModels),
    [prefs.disabledModels],
  );
  // Keep the current selection visible even if the user disabled it.
  const visible = useMemo(
    () =>
      option.choices.filter(
        (c) => !disabled.has(c.value) || c.value === option.currentValue,
      ),
    [option.choices, option.currentValue, disabled],
  );
  const groups = useMemo(() => groupByProvider(visible), [visible]);
  const current = option.choices.find((c) => c.value === option.currentValue);

  if (option.choices.length === 0) return null;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 max-w-[280px] gap-1.5 px-2 text-xs font-normal text-muted-foreground"
            title={option.name}
          >
            <span className="truncate">
              {current
                ? shortName(current.name)
                : (option.currentValue ?? "default model")}
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
                  {list.map((c) => (
                    <CommandItem
                      key={c.value}
                      value={`${provider} ${c.name} ${c.value}`}
                      onSelect={() => {
                        onChange(c.value);
                        setOpen(false);
                      }}
                      className="gap-2 rounded-md px-2 py-1.5"
                    >
                      <span className="flex-1 truncate">
                        {shortName(c.name)}
                      </span>
                      {option.currentValue === c.value && (
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
                  onManageModels();
                }}
              >
                <SlidersHorizontal className="size-3.5" /> Manage models…
              </Button>
            </div>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}
