import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTheme } from "./ThemeProvider";
import {
  EDITOR_APPS,
  TERMINAL_APPS,
  usePreferences,
} from "./PreferencesProvider";
import { THEMES } from "@/lib/themes";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: Props) {
  const { theme, setTheme, previewTheme, clearPreview } = useTheme();
  const { prefs, setPref } = usePreferences();
  const groups = ["Dark", "Light"] as const;
  const [themeOpen, setThemeOpen] = useState(false);
  const currentLabel = THEMES.find((t) => t.id === theme)?.label ?? theme;

  // Collapse the picker and revert any hover preview when the dialog closes.
  useEffect(() => {
    if (!open) {
      setThemeOpen(false);
      clearPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Appearance and preferences.</DialogDescription>
        </DialogHeader>

        <div className="py-1">
          <div className="text-sm font-medium">Theme</div>
          <div className="text-xs text-muted-foreground">
            {themeOpen ? "Hover to preview, click to apply." : "Choose a color theme."}
          </div>

          <button
            onClick={() => setThemeOpen((o) => (o ? (clearPreview(), false) : true))}
            className="mt-3 flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
          >
            <span>{currentLabel}</span>
            <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", themeOpen && "rotate-180")} />
          </button>

          {themeOpen && (
            <div className="mt-2 grid gap-3" onMouseLeave={clearPreview}>
              {groups.map((group) => (
                <div key={group}>
                  <div className="px-1 pb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                    {group}
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {THEMES.filter((t) => t.group === group).map((t) => (
                      <button
                        key={t.id}
                        onMouseEnter={() => previewTheme(t.id)}
                        onFocus={() => previewTheme(t.id)}
                        onClick={() => {
                          setTheme(t.id);
                          setThemeOpen(false);
                        }}
                        className={cn(
                          "flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm hover:bg-accent",
                          theme === t.id && "bg-accent",
                        )}
                      >
                        {t.label}
                        {theme === t.id && <Check className="size-4 text-primary" />}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          <div className="text-sm font-medium">Open in…</div>
          <AppRow
            label="Terminal"
            value={prefs.terminalApp}
            options={TERMINAL_APPS}
            onChange={(v) => setPref("terminalApp", v)}
          />
          <AppRow
            label="Editor / IDE"
            value={prefs.editorApp}
            options={EDITOR_APPS}
            onChange={(v) => setPref("editorApp", v)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AppRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
