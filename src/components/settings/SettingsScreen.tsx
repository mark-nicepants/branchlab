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
  Check,
  CircleUser,
  FlaskConical,
  FolderCog,
  FolderPlus,
  MessagesSquare,
  Palette,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { removeProject } from "../../lib/api";
import type { ProjectView } from "../../lib/types";
import {
  EDITOR_APPS,
  TERMINAL_APPS,
  usePreferences,
} from "../PreferencesProvider";
import { useTheme } from "../ThemeProvider";

export type SettingsTab =
  | "general"
  | "accounts"
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
                  onClick={() => setTab(n.id)}
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
            {tab === "accounts" && (
              <ComingSoon label="Account sign-in and identity" />
            )}
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
  return (
    <div className="flex flex-col gap-6">
      <Row
        title="Automatically check for updates"
        desc="Updates are managed by the desktop build."
      >
        <Switch checked disabled />
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
