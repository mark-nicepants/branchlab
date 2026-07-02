import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { RotateCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { readConfig, restartServer, writeConfig } from "../../lib/api";
import { OpencodeClient } from "../../lib/opencode";

interface Props {
  workspaceId: string;
  baseUrl: string | null;
  onRestarted: () => void;
}

type Scope = "project" | "global";

/**
 * Config & internals: edit the global/project opencode config files and apply
 * by restarting the server; view the effective merged config and the server's
 * agents/commands (read-only). The "see and update opencode internals" goal.
 */
export function ConfigView({ workspaceId, baseUrl, onRestarted }: Props) {
  const [scope, setScope] = useState<Scope>("project");
  const [content, setContent] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  const [effective, setEffective] = useState("");
  const [agents, setAgents] = useState<{ name: string; mode?: string }[]>([]);
  const [commands, setCommands] = useState<
    { name: string; description?: string }[]
  >([]);

  useEffect(() => {
    readConfig(scope, scope === "project" ? workspaceId : undefined)
      .then((f) => {
        setContent(f.content);
        setPath(f.path);
      })
      .catch((e) =>
        toast.error("Could not read config", { description: String(e) }),
      );
  }, [scope, workspaceId]);

  useEffect(() => {
    if (!baseUrl) {
      setEffective("");
      setAgents([]);
      setCommands([]);
      return;
    }
    const c = new OpencodeClient(baseUrl);
    c.getConfig()
      .then((cfg) => setEffective(JSON.stringify(cfg, null, 2)))
      .catch(() => {});
    c.listAgents()
      .then((a) => setAgents(Array.isArray(a) ? a : []))
      .catch(() => {});
    c.listCommands()
      .then((a) => setCommands(Array.isArray(a) ? a : []))
      .catch(() => {});
  }, [baseUrl]);

  async function save(restart: boolean) {
    setBusy(true);
    try {
      await writeConfig(
        scope,
        content,
        scope === "project" ? workspaceId : undefined,
      );
      if (restart) {
        await restartServer(workspaceId);
        onRestarted();
        toast.success("Saved & restarted");
      } else {
        toast.success("Saved");
      }
    } catch (e) {
      toast.error("Could not save config", { description: String(e) });
    }
    setBusy(false);
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Segmented>
            <SegmentedItem
              active={scope === "project"}
              onClick={() => setScope("project")}
            >
              Project
            </SegmentedItem>
            <SegmentedItem
              active={scope === "global"}
              onClick={() => setScope("global")}
            >
              Global
            </SegmentedItem>
          </Segmented>
          <span
            className="truncate font-mono text-xs text-muted-foreground"
            title={path}
          >
            {path}
          </span>
          <div className="ml-auto flex gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => void save(false)}
            >
              <Save className="size-3.5" /> Save
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => void save(true)}
            >
              <RotateCw className="size-3.5" /> Save & restart
            </Button>
          </div>
        </div>

        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          placeholder={`{\n  "$schema": "https://opencode.ai/config.json"\n}`}
          className="h-64 select-text font-mono text-xs"
        />
      </div>

      <Section title="Effective config">
        {effective ? (
          <pre className="select-text overflow-x-auto px-4 pb-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {effective}
          </pre>
        ) : (
          <Hint>Start the workspace to see the merged config.</Hint>
        )}
      </Section>

      <Section title="Agents">
        {agents.length ? (
          <ul className="px-4 pb-4 text-xs">
            {agents.map((a) => (
              <li key={a.name} className="flex justify-between py-0.5">
                <span className="font-mono">{a.name}</span>
                <span className="text-muted-foreground">{a.mode}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Hint>—</Hint>
        )}
      </Section>

      <Section title="Commands">
        {commands.length ? (
          <ul className="px-4 pb-4 text-xs">
            {commands.map((c) => (
              <li key={c.name} className="flex gap-3 py-0.5">
                <span className="font-mono">{c.name}</span>
                <span className="truncate text-muted-foreground">
                  {c.description}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Hint>—</Hint>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-border">
      <SectionLabel className="px-4 py-2">{title}</SectionLabel>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="px-4 pb-4 text-xs text-muted-foreground">{children}</p>;
}
