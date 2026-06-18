import { useCallback, useEffect, useState } from "react";
import { OpencodeClient } from "../lib/opencode";
import type { LspStatus, McpStatus } from "../lib/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { TabBarItem } from "@/components/ui/tab-bar";
import { EmptyState } from "@/components/ui/empty-state";
import { runtimeStatusBg } from "@/lib/status";
import { cn } from "@/lib/utils";

interface Props {
  baseUrl: string | null;
  version: string | null;
  workspace: boolean;
  onRestart: () => void;
}

type Tab = "mcp" | "lsp" | "plugins";

/**
 * Status-bar control for the workspace's OpenCode server. Click opens a popover
 * with MCP / LSP / Plugins tabs (OpenCode-desktop style); MCP servers can be
 * toggled on/off live via the server's connect/disconnect endpoints.
 */
export function OpencodeStatus({ baseUrl, version, workspace, onRestart }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("mcp");
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

  // Load when the popover opens (and the server is up).
  useEffect(() => {
    if (open && baseUrl) void refresh();
  }, [open, baseUrl, refresh]);

  async function toggleMcp(m: McpStatus, on: boolean) {
    if (!baseUrl) return;
    setBusy(m.name);
    const c = new OpencodeClient(baseUrl);
    try {
      await (on ? c.connectMcp(m.name) : c.disconnectMcp(m.name));
      await refresh();
    } catch {
      /* leave state; refresh will reconcile next open */
    } finally {
      setBusy(null);
    }
  }

  const running = !!baseUrl;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="flex items-center gap-1.5 truncate outline-none">
        <span className={cn("size-1.5 rounded-full", running ? "bg-additions" : "bg-muted-foreground/40")} />
        opencode{version ? ` ${version}` : ""}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-72 rounded-none p-0">
        {!running ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {workspace ? "Server not running." : "Open a workspace to start a server."}
          </p>
        ) : (
          <>
            <div className="flex items-center gap-1 border-b border-border px-1">
              <TabBarItem active={tab === "mcp"} onClick={() => setTab("mcp")} size="sm">
                {mcp.length} MCP
              </TabBarItem>
              <TabBarItem active={tab === "lsp"} onClick={() => setTab("lsp")} size="sm">
                {lsp.length ? `${lsp.length} ` : ""}LSP
              </TabBarItem>
              <TabBarItem active={tab === "plugins"} onClick={() => setTab("plugins")} size="sm">
                {plugins.length ? `${plugins.length} ` : ""}Plugins
              </TabBarItem>
            </div>

            <div className="max-h-64 overflow-y-auto p-1.5">
              {tab === "mcp" &&
                (mcp.length === 0 ? (
                  <EmptyState dense>No MCP servers configured.</EmptyState>
                ) : (
                  mcp.map((m) => (
                    <div key={m.name} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
                      <span className={cn("size-1.5 shrink-0 rounded-full", runtimeStatusBg(m.status))} />
                      <span className="min-w-0 flex-1 truncate" title={m.error ?? m.status}>
                        {m.name}
                      </span>
                      <Switch
                        checked={m.status !== "disabled" && m.status !== "failed" && m.status !== "error"}
                        disabled={busy === m.name}
                        onCheckedChange={(v) => void toggleMcp(m, v)}
                      />
                    </div>
                  ))
                ))}

              {tab === "lsp" &&
                (lsp.length === 0 ? (
                  <EmptyState dense>No LSP servers running.</EmptyState>
                ) : (
                  lsp.map((l) => (
                    <div key={l.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
                      <span className={cn("size-1.5 shrink-0 rounded-full", runtimeStatusBg(l.status))} />
                      <span className="min-w-0 flex-1 truncate">{l.id}</span>
                    </div>
                  ))
                ))}

              {tab === "plugins" &&
                (plugins.length === 0 ? (
                  <EmptyState dense>No plugins loaded.</EmptyState>
                ) : (
                  plugins.map((p) => (
                    <div key={p} className="rounded-md px-2 py-1.5 text-sm">
                      <span className="truncate">{p}</span>
                    </div>
                  ))
                ))}
            </div>

            <div className="border-t border-border p-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-full justify-center text-xs"
                onClick={() => {
                  onRestart();
                  setOpen(false);
                }}
              >
                Restart server
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}


