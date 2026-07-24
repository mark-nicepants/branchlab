import { useEffect, useState } from "react";
import {
  Braces,
  FileText,
  FolderOpen,
  MessageSquare,
  Play,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";
import type {
  Account,
  ProjectView,
  ProjectPrompts,
  ProjectType,
  ProjectUpdate,
  RunSettings,
} from "../lib/types";
import { githubDetectAccount, openExternal, updateProject } from "../lib/api";
import { useGitHub } from "../hooks/useGitHub";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui/field";
import { ConfigView } from "./center/ConfigView";
import { cn } from "@/lib/utils";

type Tab = "general" | "opencode" | "prompts" | "run";

const EMPTY_RUN: RunSettings = {
  project_type: null,
  run_script: null,
  preview_path: null,
  setup_script: null,
  teardown_script: null,
};

interface Props {
  project: ProjectView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (project: ProjectView) => void;
  /** Workspace used to read project-scoped opencode config. */
  workspaceId: string;
}

/**
 * Project settings with side navigation: General, OpenCode config, Prompts.
 * Includes path actions, editable name/base branch/default model, and editable
 * lifecycle prompts.
 */
export function ProjectSettingsDialog({
  project,
  open,
  onOpenChange,
  onUpdated,
  workspaceId,
}: Props) {
  const [tab, setTab] = useState<Tab>("general");
  const [name, setName] = useState(project.name);
  const [defaultBranch, setDefaultBranch] = useState(
    project.default_branch ?? "",
  );
  const [accountId, setAccountId] = useState(project.account_id ?? "");
  const [prompts, setPrompts] = useState<ProjectPrompts>(
    project.prompts ?? {
      init_workspace: "",
      commit: "",
      merge: "",
      push: "",
      create_pr: "",
    },
  );
  const [run, setRun] = useState<RunSettings>(project.run ?? EMPTY_RUN);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(project.name);
    setDefaultBranch(project.default_branch ?? "");
    setAccountId(project.account_id ?? "");
    setPrompts(project.prompts);
    setRun(project.run ?? EMPTY_RUN);
  }, [project]);

  async function save(updates: ProjectUpdate) {
    setSaving(true);
    try {
      const next = await updateProject(project.id, updates);
      onUpdated(next);
      toast.success("Project settings saved");
    } catch (e) {
      toast.error("Could not save project settings", {
        description: String(e),
      });
    } finally {
      setSaving(false);
    }
  }

  const tabs: {
    id: Tab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }[] = [
    { id: "general", label: "General", icon: FileText },
    { id: "run", label: "Run & preview", icon: Play },
    { id: "prompts", label: "Prompts", icon: MessageSquare },
    { id: "opencode", label: "OpenCode config", icon: Braces },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[80vh] w-[min(60rem,92vw)] grid-cols-[220px_1fr] gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogTitle className="sr-only">Project settings</DialogTitle>
        {/* Left nav — matches the app Settings screen */}
        <nav className="flex flex-col gap-0.5 overflow-y-auto border-r border-border bg-sidebar p-2">
          <div
            className="truncate px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            title={project.name}
          >
            {project.name}
          </div>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                tab === t.id
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              )}
            >
              <t.icon className="size-4 shrink-0" />
              {t.label}
            </button>
          ))}
        </nav>

        {/* Right pane */}
        <div className="min-w-0 overflow-y-auto">
          {tab === "opencode" ? (
            <div className="flex h-full flex-col">
              <div className="px-8 pb-3 pt-7">
                <h2 className="text-lg font-semibold">OpenCode config</h2>
              </div>
              <div className="min-h-0 flex-1">
                <ConfigView workspaceId={workspaceId} />
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-2xl px-8 py-7">
              <h2 className="mb-5 text-lg font-semibold">
                {tabs.find((t) => t.id === tab)?.label}
              </h2>
              {tab === "general" && (
                <GeneralTab
                  project={project}
                  name={name}
                  setName={setName}
                  defaultBranch={defaultBranch}
                  setDefaultBranch={setDefaultBranch}
                  accountId={accountId}
                  setAccountId={setAccountId}
                  saving={saving}
                  onSave={() =>
                    save({
                      name: name.trim() || project.name,
                      default_branch: defaultBranch.trim() || undefined,
                      account_id: accountId,
                    })
                  }
                />
              )}
              {tab === "prompts" && (
                <PromptsTab
                  prompts={prompts}
                  setPrompts={setPrompts}
                  saving={saving}
                  onSave={() => save({ prompts })}
                />
              )}
              {tab === "run" && (
                <RunTab
                  run={run}
                  setRun={setRun}
                  saving={saving}
                  onSave={() => save({ run: normalizeRun(run) })}
                />
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GeneralTab({
  project,
  name,
  setName,
  defaultBranch,
  setDefaultBranch,
  accountId,
  setAccountId,
  saving,
  onSave,
}: {
  project: ProjectView;
  name: string;
  setName: (v: string) => void;
  defaultBranch: string;
  setDefaultBranch: (v: string) => void;
  accountId: string;
  setAccountId: (v: string) => void;
  saving: boolean;
  onSave: () => void;
}) {
  const { accounts } = useGitHub();
  const [detected, setDetected] = useState<Account | null>(null);
  useEffect(() => {
    githubDetectAccount(project.id)
      .then(setDetected)
      .catch(() => setDetected(null));
  }, [project.id]);

  return (
    <div className="space-y-5">
      <Field label="Path">
        <div className="flex items-center gap-2">
          <Input
            value={project.root_path}
            readOnly
            className="font-mono text-xs"
          />
          <Button
            variant="outline"
            size="icon"
            title="Open in Finder"
            onClick={() =>
              openExternal(project.root_path).catch((e) =>
                toast.error(String(e)),
              )
            }
          >
            <FolderOpen className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            title="Open in terminal"
            onClick={() =>
              openExternal(project.root_path, "Terminal").catch((e) =>
                toast.error(String(e)),
              )
            }
          >
            <Terminal className="size-4" />
          </Button>
        </div>
      </Field>

      <Field label="Project name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project name"
        />
      </Field>

      <Field label="Base branch">
        <Input
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
          placeholder="main"
          className="font-mono text-xs"
        />
      </Field>

      <Field label="GitHub account">
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">
            Auto-detect{detected ? ` (@${detected.login})` : " (none found)"}
          </option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.login} · {a.host}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-muted-foreground">
          Detected from this repo's origin remote. Override if you push with a
          different identity.
        </p>
      </Field>

      <div className="flex justify-end">
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

function PromptsTab({
  prompts,
  setPrompts,
  saving,
  onSave,
}: {
  prompts: ProjectPrompts;
  setPrompts: (p: ProjectPrompts) => void;
  saving: boolean;
  onSave: () => void;
}) {
  const fields: { key: keyof ProjectPrompts; label: string }[] = [
    { key: "init_workspace", label: "Initialize workspace" },
    { key: "commit", label: "Commit changes" },
    { key: "merge", label: "Merge into base" },
    { key: "push", label: "Push branch" },
    { key: "create_pr", label: "Create pull request" },
  ];

  function update(key: keyof ProjectPrompts, value: string) {
    setPrompts({ ...prompts, [key]: value });
  }

  return (
    <div className="space-y-5">
      {fields.map(({ key, label }) => (
        <Field key={key} label={label}>
          <Textarea
            value={prompts[key] ?? ""}
            onChange={(e) => update(key, e.target.value)}
            placeholder={`Default ${label.toLowerCase()} prompt…`}
            className="min-h-[80px] font-mono text-xs"
          />
        </Field>
      ))}
      <div className="flex justify-end">
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save prompts"}
        </Button>
      </div>
    </div>
  );
}

/** Blank scripts save as null so the backend treats them as unconfigured. */
function normalizeRun(run: RunSettings): RunSettings {
  const clean = (s: string | null | undefined) => (s && s.trim() ? s : null);
  return {
    project_type: run.project_type,
    run_script: clean(run.run_script),
    preview_path: clean(run.preview_path),
    setup_script: clean(run.setup_script),
    teardown_script: clean(run.teardown_script),
  };
}

function RunTab({
  run,
  setRun,
  saving,
  onSave,
}: {
  run: RunSettings;
  setRun: (r: RunSettings) => void;
  saving: boolean;
  onSave: () => void;
}) {
  const scripts: {
    key: "run_script" | "setup_script" | "teardown_script";
    label: string;
    placeholder: string;
    hint: string;
  }[] = [
    {
      key: "run_script",
      label: "Run",
      placeholder: "npm run dev -- --port $BL_PORT",
      hint: "Dev-server command, started manually from the session view.",
    },
    {
      key: "setup_script",
      label: "Setup",
      placeholder: "npm install && ln -sf $BL_PROJECT_ROOT/.env .env",
      hint: "Runs once in every fresh worktree, right after creation.",
    },
    {
      key: "teardown_script",
      label: "Teardown",
      placeholder: "docker compose down",
      hint: "Best-effort (30s cap) before a worktree is removed.",
    },
  ];

  return (
    <div className="space-y-5">
      <Field label="Project type">
        <select
          value={run.project_type ?? ""}
          onChange={(e) =>
            setRun({
              ...run,
              project_type: (e.target.value || null) as ProjectType | null,
            })
          }
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Not set</option>
          <option value="web">Web — preview in an embedded browser</option>
          <option value="flutter">Flutter — runs on a local device</option>
          <option value="flutter-redroid">
            Flutter · redroid — Android in a container, previewed in-app
          </option>
        </select>
        {run.project_type === "flutter-redroid" && (
          <p className="mt-1 text-xs text-muted-foreground">
            Needs Docker or Apple's <code>container</code> plus <code>adb</code>
            . The run script gets <code>$ANDROID_SERIAL</code> pointed at the
            container — e.g.{" "}
            <code>flutter run -d $ANDROID_SERIAL --no-resident</code>.
          </p>
        )}
      </Field>

      {run.project_type === "web" && (
        <Field label="Preview path">
          <Input
            value={run.preview_path ?? ""}
            onChange={(e) => setRun({ ...run, preview_path: e.target.value })}
            placeholder="/admin"
            spellCheck={false}
            className="font-mono text-xs"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Opened on the discovered port when the preview starts — for apps
            whose homepage redirects. Empty = <code>/</code>.
          </p>
        </Field>
      )}

      {scripts.map(({ key, label, placeholder, hint }) => (
        <Field key={key} label={label}>
          <Textarea
            value={run[key] ?? ""}
            onChange={(e) => setRun({ ...run, [key]: e.target.value })}
            placeholder={placeholder}
            spellCheck={false}
            className="min-h-[56px] font-mono text-xs"
          />
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        </Field>
      ))}
      <p className="text-xs text-muted-foreground">
        Commands run with <code>sh -lc</code> in the worktree, with{" "}
        <code>$BL_PORT</code> (a free port), <code>$BL_PROJECT_ROOT</code>,{" "}
        <code>$BL_WORKTREE_PATH</code> and <code>$BL_WORKSPACE_ID</code> (a
        stable key for per-worktree databases etc.) in the environment.
      </p>
      <div className="flex justify-end">
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save run settings"}
        </Button>
      </div>
    </div>
  );
}
