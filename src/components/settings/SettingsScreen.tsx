import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { THEMES } from "@/lib/themes";
import { cn } from "@/lib/utils";
import {
  Accessibility,
  ArrowUpCircle,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CircleUser,
  FlaskConical,
  FolderCog,
  FolderPlus,
  MessagesSquare,
  Palette,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  getDefaultModel,
  removeProject,
  setDefaultModel,
  telemetryGetEnabled,
  telemetrySetEnabled,
} from "../../lib/api";
import { groupByProvider, shortName } from "../../lib/models";
import type { ProjectView } from "../../lib/types";
import { Input } from "@/components/ui/input";
import { AccountsTab } from "./AccountsTab";
import {
  EDITOR_APPS,
  TERMINAL_APPS,
  usePreferences,
} from "../PreferencesProvider";
import { useTheme } from "../ThemeProvider";
import { useAppUpdate } from "@/hooks/useUpdateChecker";

export type SettingsTab =
  | "general"
  | "accounts"
  | "models"
  | "sessions"
  | "themes"
  | "accessibility"
  | "skills"
  | "experimental"
  | "projects";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: SettingsTab;
  /** Reports internal tab switches (feeds the router's pageview tracking). */
  onTabChange?: (tab: SettingsTab) => void;
  projects: ProjectView[];
  onProjectsChanged: () => void;
  onAddProject: () => void;
  onOpenProjectSettings: (project: ProjectView) => void;
}

interface NavItem {
  id: SettingsTab;
  label: string;
  icon: typeof SettingsIcon;
  group: "top" | "tools";
}

const NAV: NavItem[] = [
  { id: "general", label: "General", icon: SettingsIcon, group: "top" },
  { id: "accounts", label: "Accounts", icon: CircleUser, group: "top" },
  { id: "models", label: "Models", icon: Boxes, group: "top" },
  { id: "sessions", label: "Sessions", icon: MessagesSquare, group: "top" },
  { id: "themes", label: "Themes", icon: Palette, group: "top" },
  {
    id: "accessibility",
    label: "Accessibility",
    icon: Accessibility,
    group: "top",
  },
  { id: "skills", label: "Skills", icon: Sparkles, group: "tools" },
  {
    id: "experimental",
    label: "Experimental",
    icon: FlaskConical,
    group: "tools",
  },
  { id: "projects", label: "Projects", icon: FolderCog, group: "tools" },
];

export function SettingsScreen({
  open,
  onOpenChange,
  initialTab = "general",
  onTabChange,
  projects,
  onProjectsChanged,
  onAddProject,
  onOpenProjectSettings,
}: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const { clearPreview } = useTheme();

  useEffect(() => {
    if (open) setTab(initialTab);
    else clearPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTab]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid h-[80vh] w-[min(60rem,92vw)] grid-cols-[220px_1fr] gap-0 overflow-hidden p-0 sm:max-w-none"
        onMouseLeave={clearPreview}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        {/* Left nav */}
        <nav className="flex flex-col gap-0.5 overflow-y-auto border-r border-border bg-sidebar p-2">
          {(["top", "tools"] as const).map((group, gi) => (
            <div
              key={group}
              className={cn(
                gi > 0 && "mt-3 border-t border-sidebar-border pt-3",
              )}
            >
              {NAV.filter((n) => n.group === group).map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    setTab(n.id);
                    onTabChange?.(n.id);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                    tab === n.id
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                  )}
                >
                  <n.icon className="size-4 shrink-0" />
                  {n.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* Right pane */}
        <div className="min-w-0 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-8 py-7">
            <h2 className="mb-5 text-lg font-semibold">
              {NAV.find((n) => n.id === tab)?.label}
            </h2>
            {tab === "general" && <GeneralTab />}
            {tab === "themes" && <ThemesTab />}
            {tab === "projects" && (
              <ProjectsTab
                projects={projects}
                onProjectsChanged={onProjectsChanged}
                onAddProject={onAddProject}
                onOpenProjectSettings={onOpenProjectSettings}
              />
            )}
            {tab === "accounts" && <AccountsTab />}
            {tab === "models" && <ModelsTab />}
            {tab === "sessions" && (
              <ComingSoon label="Session defaults and retention" />
            )}
            {tab === "accessibility" && (
              <ComingSoon label="Accessibility options" />
            )}
            {tab === "skills" && <ComingSoon label="Agent skills management" />}
            {tab === "experimental" && (
              <ComingSoon label="Experimental features" />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── General ──

function GeneralTab() {
  const { prefs, setPref } = usePreferences();
  const { availableVersion, installing, installUpdate } = useAppUpdate();
  // Anonymous usage telemetry opt-out; the flag lives in the backend so it
  // also gates events the supervisor sends when this screen isn't open.
  const [telemetry, setTelemetry] = useState<boolean | null>(null);
  useEffect(() => {
    void telemetryGetEnabled().then(setTelemetry);
  }, []);
  return (
    <div className="flex flex-col gap-6">
      {availableVersion && (
        <div className="flex items-center gap-3 rounded-lg border border-info/40 bg-info/10 px-4 py-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-info/15 text-info">
            <ArrowUpCircle className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              BranchLab {availableVersion} is available
            </div>
            <div className="text-xs text-muted-foreground">
              Installs in the background, then restarts the app.
            </div>
          </div>
          <Button size="sm" onClick={() => void installUpdate()} disabled={installing}>
            {installing ? "Updating…" : "Update & restart"}
          </Button>
        </div>
      )}
      <Row
        title="Automatically check for updates"
        desc="Checks the release feed on launch and every few hours."
      >
        <Switch
          checked={prefs.autoCheckUpdates}
          onCheckedChange={(on) => setPref("autoCheckUpdates", on)}
        />
      </Row>
      <Row
        title="Share anonymous usage data"
        desc="Screen views and feature counts only — never code, paths, prompts, or anything identifying."
      >
        <Switch
          checked={telemetry ?? true}
          disabled={telemetry === null}
          onCheckedChange={(on) => {
            setTelemetry(on);
            void telemetrySetEnabled(on);
          }}
        />
      </Row>
      <Field
        title="Storage location"
        desc="Where repositories and worktrees are stored."
      >
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
          ~/Library/Application&nbsp;Support/BranchLab/worktrees
        </div>
      </Field>
      <Field
        title="Open in…"
        desc="Apps used for the terminal and IDE actions."
      >
        <div className="flex flex-col gap-2">
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
      </Field>
    </div>
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
  onChange: (v: string) => void;
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

// ── Themes ──

function ThemesTab() {
  const { theme, setTheme, previewTheme, clearPreview } = useTheme();
  const groups = ["Dark", "Light"] as const;
  const current = THEMES.find((t) => t.id === theme);

  return (
    <div className="flex flex-col gap-6">
      <Field title="Current theme" desc="Customize the app's color palette.">
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
          <div className="flex h-11 w-16 flex-col justify-center gap-1 rounded-md border border-border bg-background px-2">
            <span
              className="h-1.5 w-full rounded-full"
              style={{ background: "var(--primary)" }}
            />
            <span
              className="h-1.5 w-3/4 rounded-full"
              style={{ background: "var(--muted-foreground)" }}
            />
            <span
              className="h-1.5 w-1/2 rounded-full"
              style={{ background: "var(--border)" }}
            />
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium">{current?.label ?? theme}</div>
            <div className="mt-1.5 flex gap-1">
              {[
                "--primary",
                "--additions",
                "--warning",
                "--destructive",
                "--info",
              ].map((v) => (
                <span
                  key={v}
                  className="size-3 rounded-full border border-border"
                  style={{ background: `var(${v})` }}
                />
              ))}
            </div>
          </div>
        </div>
      </Field>

      <div onMouseLeave={clearPreview}>
        {groups.map((group) => (
          <div key={group} className="mb-4">
            <div className="mb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
              {group}
            </div>
            <div className="grid grid-cols-2 gap-1">
              {THEMES.filter((t) => t.group === group).map((t) => (
                <button
                  key={t.id}
                  onMouseEnter={() => previewTheme(t.id)}
                  onFocus={() => previewTheme(t.id)}
                  onClick={() => setTheme(t.id)}
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
    </div>
  );
}

// ── Projects ──

function ProjectsTab({
  projects,
  onProjectsChanged,
  onAddProject,
  onOpenProjectSettings,
}: {
  projects: ProjectView[];
  onProjectsChanged: () => void;
  onAddProject: () => void;
  onOpenProjectSettings: (p: ProjectView) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Git repositories registered with BranchLab.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onAddProject}
        >
          <FolderPlus className="size-3.5" /> Add project
        </Button>
      </div>
      {projects.length === 0 ? (
        <EmptyState
          className="py-10"
          icon={<FolderCog className="size-6 text-muted-foreground/60" />}
        >
          No projects yet.
        </EmptyState>
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {projects.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{p.name}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {p.root_path}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenProjectSettings(p)}
              >
                <SettingsIcon className="size-3.5" /> Settings
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-destructive"
                onClick={() => void removeProject(p.id).then(onProjectsChanged)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Models ──

function ModelsTab() {
  const { prefs, setPref } = usePreferences();
  const catalog = prefs.modelCatalog;
  const [query, setQuery] = useState("");
  const [defaultModel, setDefault] = useState<string>("");

  // Which provider groups are expanded in the available-models list.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleProvider = (provider: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });

  useEffect(() => {
    getDefaultModel()
      .then((m) => setDefault(m ?? ""))
      .catch(() => setDefault(""));
  }, []);

  const disabled = useMemo(
    () => new Set(prefs.disabledModels),
    [prefs.disabledModels],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.value.toLowerCase().includes(q),
    );
  }, [catalog, query]);
  const groups = useMemo(() => groupByProvider(filtered), [filtered]);
  const defaultGroups = useMemo(() => groupByProvider(catalog), [catalog]);

  const enabledCount = filtered.filter((c) => !disabled.has(c.value)).length;
  const allEnabled = filtered.length > 0 && enabledCount === filtered.length;

  function toggle(value: string, enabled: boolean) {
    const next = new Set(prefs.disabledModels);
    if (enabled) next.delete(value);
    else next.add(value);
    setPref("disabledModels", [...next]);
  }

  function toggleAll() {
    const next = new Set(prefs.disabledModels);
    for (const c of filtered) {
      if (allEnabled) next.add(c.value);
      else next.delete(c.value);
    }
    setPref("disabledModels", [...next]);
  }

  function changeDefault(value: string) {
    setDefault(value);
    void setDefaultModel(value).catch(() => {});
  }

  if (catalog.length === 0) {
    return (
      <EmptyState
        className="py-16"
        icon={<Boxes className="size-6 text-muted-foreground/60" />}
      >
        Open a workspace once to load the available models.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Field
        title="Default model"
        desc="Applied to every new workspace session. Individual workspaces can still switch models."
      >
        <select
          value={defaultModel}
          onChange={(e) => changeDefault(e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Automatic (opencode default)</option>
          {defaultGroups.map(([provider, list]) => (
            <optgroup key={provider} label={provider}>
              {list.map((c) => (
                <option key={c.value} value={c.value}>
                  {shortName(c.name)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>

      <div>
        <div className="text-sm font-medium">Available models</div>
        <div className="mb-2.5 mt-0.5 text-xs text-muted-foreground">
          Choose which models appear in the composer's model picker.
        </div>
        <div className="mb-2 flex items-center gap-2">
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
        <div className="overflow-hidden rounded-lg border border-border">
          {groups.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No models found.
            </p>
          ) : (
            groups.map(([provider, list]) => {
              const enabled = list.filter((c) => !disabled.has(c.value)).length;
              // Collapsed by default; searching forces every matching group open.
              const isOpen = query.trim() !== "" || expanded.has(provider);
              return (
                <div
                  key={provider}
                  className="border-b border-border last:border-b-0"
                >
                  <button
                    onClick={() => toggleProvider(provider)}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/50"
                  >
                    {isOpen ? (
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex-1 text-sm font-medium">
                      {provider}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {enabled} of {list.length} enabled
                    </span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-border bg-muted/20 px-1.5 py-1">
                      {list.map((c) => (
                        <label
                          key={c.value}
                          className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm hover:bg-accent"
                        >
                          <span className="min-w-0 truncate">
                            {shortName(c.name)}
                          </span>
                          <Switch
                            checked={!disabled.has(c.value)}
                            onCheckedChange={(v) => toggle(c.value, v)}
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ── Shared bits ──

function Field({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-sm font-medium">{title}</div>
      {desc && (
        <div className="mb-2.5 mt-0.5 text-xs text-muted-foreground">
          {desc}
        </div>
      )}
      {children}
    </div>
  );
}

function Row({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div>
        <div className="text-sm font-medium">{title}</div>
        {desc && (
          <div className="mt-0.5 text-xs text-muted-foreground">{desc}</div>
        )}
      </div>
      {children}
    </div>
  );
}

function ComingSoon({ label }: { label: string }) {
  return (
    <EmptyState
      className="py-16"
      icon={<Sparkles className="size-6 text-muted-foreground/60" />}
    >
      {label} is coming soon.
    </EmptyState>
  );
}
