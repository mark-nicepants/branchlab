// Centralized semantic status → presentation maps.
// Use these instead of hardcoding colors per component.

/** File change status (from git): letter + Tailwind text color class. */
export const FILE_STATUS: Record<string, { letter: string; className: string }> = {
  added: { letter: "A", className: "text-additions" },
  untracked: { letter: "U", className: "text-additions" },
  modified: { letter: "M", className: "text-warning" },
  deleted: { letter: "D", className: "text-deletions" },
  renamed: { letter: "R", className: "text-info" },
};

export function fileStatus(status: string): { letter: string; className: string } {
  return FILE_STATUS[status] ?? FILE_STATUS.modified;
}

/** Background class for an MCP/LSP/server runtime status dot. */
export function runtimeStatusBg(status: string | undefined): string {
  if (status === "connected" || status === "active" || status === "running") return "bg-additions";
  if (status === "failed" || status === "error") return "bg-deletions";
  if (status === "disabled") return "bg-muted-foreground/40";
  return "bg-warning";
}

/** Background class for a todo status dot. */
export function todoStatusBg(status: string): string {
  if (status === "completed") return "bg-additions";
  if (status === "in_progress") return "bg-info";
  if (status === "pending") return "bg-warning";
  if (status === "cancelled") return "bg-destructive";
  return "bg-muted-foreground";
}
