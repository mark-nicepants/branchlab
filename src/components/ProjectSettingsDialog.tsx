import { useEffect, useState } from "react";
import {
  Braces,
  FileText,
  FolderOpen,
  Loader2,
  MessageSquare,
  Sparkles,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";
import type {
  Account,
  EstimateUnit,
  ProjectView,
  ProjectPrompts,
  ProjectUpdate,
  RunSettings,
} from "../lib/types";
import {
  generateSetupScripts,
  githubDetectAccount,
  openExternal,
  updateProject,
} from "../lib/api";
import { useGitHub } from "../hooks/useGitHub";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui/field";
import { ConfigView } from "./center/ConfigView";
import { cn } from "@/lib/utils";

type Tab = "general" | "opencode" | "prompts" | "scripts";

interface Props {
  project: ProjectView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (project: ProjectView) => void;
  /** Workspace used to read project-scoped opencode config. */
  workspaceId: string;
  onConfigRestarted: () => void;
  /** Tab to show when the dialog opens (e.g. "scripts" right after adding a
   *  project, so lifecycle scripts are discoverable). Default "general". */
  initialTab?: Tab;
}

/**
 * Project settings with side navigation: General, OpenCode config, Prompts.
 * Includes path actions, editable name/base branch, and editable
 * lifecycle prompts.
 */
export function ProjectSettingsDialog({
  project,
  open,
  onOpenChange,
  onUpdated,
  workspaceId,
  onConfigRestarted,
  initialTab,
}: Props) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "general");
  const [name, setName] = useState(project.name);
  const [defaultBranch, setDefaultBranch] = useState(
    project.default_branch ?? "",
  );
  const [accountId, setAccountId] = useState(project.account_id ?? "");
  // "" = use the board-global unit (stored as null).
  const [estimateUnit, setEstimateUnit] = useState(
    project.estimate_unit ?? "",
  );
  const [prompts, setPrompts] = useState<ProjectPrompts>(
    project.prompts ?? {
      init_workspace: "",
      commit: "",
      merge: "",
      push: "",
      create_pr: "",
    },
  );
  const [run, setRun] = useState<RunSettings>(
    project.run ?? { setup_script: null, teardown_script: null },
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(project.name);
    setDefaultBranch(project.default_branch ?? "");
    setAccountId(project.account_id ?? "");
    setEstimateUnit(project.estimate_unit ?? "");
    setPrompts(project.prompts);
    setRun(project.run ?? { setup_script: null, teardown_script: null });
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
    { id: "prompts", label: "Prompts", icon: MessageSquare },
    { id: "scripts", label: "Scripts", icon: Terminal },
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
                <ConfigView
                  workspaceId={workspaceId}
                  onRestarted={onConfigRestarted}
                />
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
                  estimateUnit={estimateUnit}
                  setEstimateUnit={setEstimateUnit}
                  saving={saving}
                  onSave={() => {
                    const unit = (estimateUnit || null) as EstimateUnit | null;
                    save({
                      name: name.trim() || project.name,
                      default_branch: defaultBranch.trim() || undefined,
                      account_id: accountId,
                      // Nested-option field: MUST be omitted entirely when
                      // untouched — null means "clear back to global".
                      ...(unit !== (project.estimate_unit ?? null)
                        ? { estimate_unit: unit }
                        : {}),
                    });
                  }}
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
              {tab === "scripts" && (
                <ScriptsTab
                  projectId={project.id}
                  run={run}
                  setRun={setRun}
                  saving={saving}
                  onSave={() =>
                    save({
                      run: {
                        setup_script: run.setup_script?.trim() || null,
                        teardown_script: run.teardown_script?.trim() || null,
                      },
                    })
                  }
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
  estimateUnit,
  setEstimateUnit,
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
  /** "" = use the board-global unit. */
  estimateUnit: string;
  setEstimateUnit: (v: string) => void;
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

      <Field label="Estimates">
        <select
          value={estimateUnit}
          onChange={(e) => setEstimateUnit(e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Default (use global)</option>
          <option value="points">Story points</option>
          <option value="hours">Hours</option>
          <option value="tshirt">T-shirt sizes</option>
        </select>
        <p className="mt-1 text-xs text-muted-foreground">
          How this project's task estimates are read; the default follows
          Settings → General.
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

function ScriptsTab({
  projectId,
  run,
  setRun,
  saving,
  onSave,
}: {
  projectId: string;
  run: RunSettings;
  setRun: (r: RunSettings) => void;
  saving: boolean;
  onSave: () => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);

  async function generate() {
    setGenerating(true);
    setNotes(null);
    try {
      const proposal = await generateSetupScripts(projectId);
      setRun({
        setup_script: proposal.setup_script,
        teardown_script: proposal.teardown_script,
      });
      setNotes(proposal.notes);
      toast.success("Scripts proposed — review and save");
    } catch (e) {
      toast.error("Could not generate scripts", { description: String(e) });
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          Let the AI read the project's manifests and propose scripts. The
          result only fills the fields below — review it, then save.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void generate()}
          disabled={generating}
          className="shrink-0"
        >
          {generating ? (
            <>
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              Analyzing repo…
            </>
          ) : (
            <>
              <Sparkles className="mr-1.5 size-3.5" />
              Generate with AI
            </>
          )}
        </Button>
      </div>
      {notes && (
        <p className="rounded-md border border-border bg-accent/40 px-3 py-2 text-xs text-muted-foreground">
          {notes}
        </p>
      )}

      <Field label="Setup script">
        <Textarea
          value={run.setup_script ?? ""}
          onChange={(e) => setRun({ ...run, setup_script: e.target.value })}
          placeholder="npm install && ln -sf $BL_PROJECT_ROOT/.env .env"
          className="min-h-[80px] font-mono text-xs"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Runs once in every fresh workspace, before your first prompt is
          delivered.
        </p>
      </Field>

      <Field label="Teardown script">
        <Textarea
          value={run.teardown_script ?? ""}
          onChange={(e) => setRun({ ...run, teardown_script: e.target.value })}
          placeholder="docker compose down"
          className="min-h-[80px] font-mono text-xs"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Best-effort, max 30s, runs before a workspace is deleted.
        </p>
      </Field>

      <p className="text-xs text-muted-foreground">
        Available environment variables:{" "}
        <span className="font-mono">BL_WORKTREE_PATH</span>,{" "}
        <span className="font-mono">BL_PROJECT_ROOT</span>,{" "}
        <span className="font-mono">BL_WORKSPACE_ID</span>.
      </p>

      <div className="flex justify-end">
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save scripts"}
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
