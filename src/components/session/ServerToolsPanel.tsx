import { useCallback, useEffect, useState } from "react";
import { FileText, RotateCw } from "lucide-react";
import {
  logPath,
  mcpConnect,
  mcpDisconnect,
  openExternal,
  workspaceTools,
} from "../../lib/api";
import type { LspStatus, McpStatus } from "../../lib/types";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { runtimeStatusBg } from "@/lib/status";
import { cn } from "@/lib/utils";

interface Props {
  workspaceId: string;
  onRestart: () => void;
}

/**
 * The workspace engine's runtime tools — MCP + LSP servers. ACP doesn't expose
 * runtime status, so this reads it from a supplemental on-demand `opencode serve`
 * (started lazily when this panel opens, idle-reaped afterward). MCP servers can
 * be connected/disconnected live.
 */
export function ServerToolsPanel({ workspaceId, onRestart }: Props) {
  const [mcp, setMcp] = useState<McpStatus[]>([]);
  const [lsp, setLsp] = useState<LspStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const t = await workspaceTools(workspaceId);
      setMcp(t.mcp);
      setLsp(t.lsp);
    } catch (e) {
      // Surface the reason instead of silently showing "none configured" — the
      // supplemental `opencode serve` may have failed to start (see logs).
      setError(String(e));
      setMcp([]);
      setLsp([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const openLogs = useCallback(async () => {
    const p = await logPath();
    if (p) void openExternal(p);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggleMcp(m: McpStatus, on: boolean) {
    setBusy(m.name);
    try {
      await (on
        ? mcpConnect(workspaceId, m.name)
        : mcpDisconnect(workspaceId, m.name));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p
            className="border-b border-border px-3 py-2 text-xs text-destructive"
            title={error}
          >
            Couldn't reach the engine server: {error}
          </p>
        )}
        <Section title="MCP servers" count={mcp.length}>
          {mcp.length === 0 ? (
            <SectionEmpty>
              {loading ? "Loading…" : "No MCP servers configured."}
            </SectionEmpty>
          ) : (
            mcp.map((m) => {
              const on =
                m.status !== "disabled" &&
                m.status !== "failed" &&
                m.status !== "error";
              return (
                <Item key={m.name}>
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      runtimeStatusBg(m.status),
                    )}
                  />
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={m.error ?? m.status}
                  >
                    {m.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {m.status}
                  </span>
                  <Switch
                    checked={on}
                    disabled={busy === m.name}
                    onCheckedChange={(v) => void toggleMcp(m, v)}
                  />
                </Item>
              );
            })
          )}
        </Section>

        <Section title="Language servers" count={lsp.length}>
          {lsp.length === 0 ? (
            <SectionEmpty>
              {loading ? "Loading…" : "No LSP servers running."}
            </SectionEmpty>
          ) : (
            lsp.map((l) => (
              <Item key={l.id}>
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    runtimeStatusBg(l.status),
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{l.id}</span>
                {l.status && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {l.status}
                  </span>
                )}
              </Item>
            ))
          )}
        </Section>

        {!loading && mcp.length === 0 && lsp.length === 0 && (
          <EmptyState className="py-6">
            Runtime tools appear here when the engine's server is reachable.
          </EmptyState>
        )}
      </div>

      <div className="flex flex-col gap-1 border-t border-border p-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-center gap-1.5 text-xs"
          onClick={onRestart}
        >
          <RotateCw className="size-3.5" /> Restart engine
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-center gap-1.5 text-xs text-muted-foreground"
          onClick={() => void openLogs()}
        >
          <FileText className="size-3.5" /> Open debug log
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-2 px-3 pb-1 pt-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {count > 0 && (
          <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
            {count}
          </span>
        )}
      </div>
      <div className="px-1.5 pb-2">{children}</div>
    </section>
  );
}

function Item({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
      {children}
    </div>
  );
}

function SectionEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 py-1.5 text-xs text-muted-foreground">{children}</p>
  );
}
