import { Button } from "@/components/ui/button";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { RotateCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { readConfig, restartServer, writeConfig } from "../../lib/api";

interface Props {
  workspaceId: string;
}

type Scope = "project" | "global";

/**
 * Config & internals: edit the global/project opencode config files and apply
 * by restarting the engine. Effective-config / agents / commands are now
 * advertised per-session over ACP (see the composer selectors), not fetched
 * over HTTP here.
 */
export function ConfigView({ workspaceId }: Props) {
  const [scope, setScope] = useState<Scope>("project");
  const [content, setContent] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

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
    </div>
  );
}
