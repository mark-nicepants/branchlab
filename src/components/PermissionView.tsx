import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChatPermChoice } from "../lib/types";

interface Props {
  title: string | null;
  options: ChatPermChoice[];
  onSelect: (optionId: string) => void;
  onCancel: () => void;
}

/**
 * An ACP permission request: the agent wants approval for a tool call. Unlike
 * the old multi-select questions, ACP permissions are a single choice among
 * allow/reject options — pick one (or cancel the turn).
 */
export function PermissionView({ title, options, onSelect, onCancel }: Props) {
  const isAllow = (kind: string) => kind.startsWith("allow");
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm">
      <div className="mb-2 font-medium">{title ?? "Allow this action?"}</div>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Button
            key={o.optionId}
            size="sm"
            variant={isAllow(o.kind) ? "default" : "outline"}
            className={cn(!isAllow(o.kind) && "text-destructive")}
            onClick={() => onSelect(o.optionId)}
          >
            {o.name}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
