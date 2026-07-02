import { useCallback, useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { OpencodeClient } from "../../lib/opencode";
import type { LspStatus, McpStatus } from "../../lib/types";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { runtimeStatusBg } from "@/lib/status";
import { cn } from "@/lib/utils";

interface Props {
  baseUrl: string | null;
  onRestart: () => void;
}

/**
 * The workspace server's runtime tools — MCP servers, LSP servers and plugins —
 * shown in the session's side panel (Config tab) as stacked sections. These are
 * per-workspace (they belong to that server), so they live here rather than in
 * global settings. MCP servers can be connected/disconnected live.
 */
export function ServerToolsPanel({ baseUrl, onRestart }: Props) {
  const [mcp, setMcp] = useState<McpStatus[]>([]);
  const [lsp, setLsp] = useState<LspStatus[]>([]);
  const [plugins, setPlugins] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!baseUrl) return;
    const c = new OpencodeClient(baseUrl);
    const [m, l, p] = await Promise.all([
      c.listMcp().catch(() => []),
      c.listLsp().catch(() => []),
      c.listPlugins().catch(() => []),
    ]);
    setMcp(m);
    setLsp(l);
    setPlugins(p);
  }, [baseUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggleMcp(m: McpStatus, on: boolean) {
    if (!baseUrl) return;
    setBusy(m.name);
    const c = new OpencodeClient(baseUrl);
    try {
      await (on ? c.connectMcp(m.name) : c.disconnectMcp(m.name));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  if (!baseUrl) {
    return <EmptyState className="py-10">Server not running.</EmptyState>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="MCP servers" count={mcp.length}>
          {mcp.length === 0 ? (
            <SectionEmpty>No MCP servers configured.</SectionEmpty>
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
            <SectionEmpty>No LSP servers running.</SectionEmpty>
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

        <Section title="Plugins" count={plugins.length}>
          {plugins.length === 0 ? (
            <SectionEmpty>No plugins loaded.</SectionEmpty>
          ) : (
            plugins.map((p) => (
              <Item key={p}>
                <span className="min-w-0 flex-1 truncate">{p}</span>
              </Item>
            ))
          )}
        </Section>
      </div>

      <div className="border-t border-border p-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-center gap-1.5 text-xs"
          onClick={onRestart}
        >
          <RotateCw className="size-3.5" /> Restart server
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
