import { useEffect, useState } from "react";
import {
  Braces,
  FileText,
  FolderOpen,
  MessageSquare,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";
import type { ProjectView, ProjectPrompts, ProjectUpdate, ModelOption } from "../lib/types";
import { openExternal, serverStatus, updateProject } from "../lib/api";
import { OpencodeClient } from "../lib/opencode";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfigView } from "./center/ConfigView";
import { cn } from "@/lib/utils";

type Tab = "general" | "opencode" | "prompts";

interface Props {
  project: ProjectView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (project: ProjectView) => void;
  /** Workspace used to read project-scoped opencode config. */
  workspaceId: string;
  onConfigRestarted: () => void;
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
  onConfigRestarted,
}: Props) {
  const [tab, setTab] = useState<Tab>("general");
  const [name, setName] = useState(project.name);
  const [defaultBranch, setDefaultBranch] = useState(project.default_branch ?? "");
  const [defaultModelKey, setDefaultModelKey] = useState(project.default_model_key ?? "");
  const [prompts, setPrompts] = useState<ProjectPrompts>(
    project.prompts ?? {
      init_workspace: "",
      commit: "",
      merge: "",
      push: "",
      create_pr: "",
    },
  );
  const [models, setModels] = useState<ModelOption[]>([]);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(project.name);
    setDefaultBranch(project.default_branch ?? "");
    setDefaultModelKey(project.default_model_key ?? "");
    setPrompts(project.prompts);
  }, [project]);

  useEffect(() => {
    if (!open || !workspaceId) return;
    serverStatus(workspaceId)
      .then((info) => {
        if (!info) return;
        setBaseUrl(info.base_url);
        return new OpencodeClient(info.base_url).listModels();
      })
      .then((res) => {
        if (res) setModels(res.models);
      })
      .catch(() => {});
  }, [open, workspaceId]);

  async function save(updates: ProjectUpdate) {
    setSaving(true);
    try {
      const next = await updateProject(project.id, updates);
      onUpdated(next);
      toast.success("Project settings saved");
    } catch (e) {
      toast.error("Could not save project settings", { description: String(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-[80vw] max-w-none flex-row gap-0 overflow-hidden rounded-lg bg-card p-0 text-card-foreground">
        <nav className="flex w-56 flex-col border-r border-border/50 bg-card">
          <div className="px-5 py-4">
            <DialogTitle className="text-sm font-medium">Project settings</DialogTitle>
          </div>
          <NavItem tab="general" current={tab} icon={FileText} onClick={setTab}>
            General
          </NavItem>
          <NavItem tab="opencode" current={tab} icon={Braces} onClick={setTab}>
            OpenCode config
          </NavItem>
          <NavItem tab="prompts" current={tab} icon={MessageSquare} onClick={setTab}>
            Prompts
          </NavItem>
        </nav>

        <div className="flex min-h-0 flex-1 flex-col bg-card">
          <DialogHeader className="border-b border-border/50 px-6 py-4">
            <DialogTitle className="text-base font-medium">
              {tab === "general" && "General"}
              {tab === "opencode" && "OpenCode config"}
              {tab === "prompts" && "Prompts"}
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            {tab === "general" && (
              <GeneralTab
                project={project}
                name={name}
                setName={setName}
                defaultBranch={defaultBranch}
                setDefaultBranch={setDefaultBranch}
                defaultModelKey={defaultModelKey}
                setDefaultModelKey={setDefaultModelKey}
                models={models}
                saving={saving}
                onSave={() =>
                  save({
                    name: name.trim() || project.name,
                    default_branch: defaultBranch.trim() || undefined,
                    default_model_key: defaultModelKey.trim() || null,
                  })
                }
              />
            )}
            {tab === "opencode" && (
              <ConfigView workspaceId={workspaceId} baseUrl={baseUrl} onRestarted={onConfigRestarted} />
            )}
            {tab === "prompts" && (
              <PromptsTab
                prompts={prompts}
                setPrompts={setPrompts}
                saving={saving}
                onSave={() => save({ prompts })}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NavItem({
  tab,
  current,
  icon: Icon,
  onClick,
  children,
}: {
  tab: Tab;
  current: Tab;
  icon: React.ComponentType<{ className?: string }>;
  onClick: (tab: Tab) => void;
  children: React.ReactNode;
}) {
  const active = tab === current;
  return (
    <button
      onClick={() => onClick(tab)}
      className={cn(
        "flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm transition-colors",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <Icon className="size-4" />
      {children}
    </button>
  );
}

function GeneralTab({
  project,
  name,
  setName,
  defaultBranch,
  setDefaultBranch,
  defaultModelKey,
  setDefaultModelKey,
  models,
  saving,
  onSave,
}: {
  project: ProjectView;
  name: string;
  setName: (v: string) => void;
  defaultBranch: string;
  setDefaultBranch: (v: string) => void;
  defaultModelKey: string;
  setDefaultModelKey: (v: string) => void;
  models: ModelOption[];
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <div className="space-y-5">
      <Field label="Path">
        <div className="flex items-center gap-2">
          <Input value={project.root_path} readOnly className="font-mono text-xs" />
          <Button
            variant="outline"
            size="icon"
            title="Open in Finder"
            onClick={() => openExternal(project.root_path).catch((e) => toast.error(String(e)))}
          >
            <FolderOpen className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            title="Open in terminal"
            onClick={() =>
              openExternal(project.root_path, "Terminal").catch((e) => toast.error(String(e)))
            }
          >
            <Terminal className="size-4" />
          </Button>
        </div>
      </Field>

      <Field label="Project name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" />
      </Field>

      <Field label="Base branch">
        <Input
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
          placeholder="main"
          className="font-mono text-xs"
        />
      </Field>

      <Field label="Default model">
        <select
          value={defaultModelKey}
          onChange={(e) => setDefaultModelKey(e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">Use workspace default</option>
          {models.map((m) => (
            <option key={m.key} value={m.key}>
              {m.providerName} / {m.name}
            </option>
          ))}
        </select>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
