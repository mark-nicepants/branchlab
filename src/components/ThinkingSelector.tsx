import { ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Props {
  /** Reasoning-effort variants the active model supports (server order). */
  variants: string[];
  /** Selected variant, or null for the model's default. */
  value: string | null;
  onChange: (variant: string | null) => void;
}

/** Sentinel radio value for "use the model's default reasoning effort". */
const DEFAULT = "__default__";

/** "xhigh" → "Xhigh", "high" → "High". */
function label(variant: string): string {
  return variant.charAt(0).toUpperCase() + variant.slice(1);
}

/**
 * Reasoning-effort ("thinking") picker for the chat composer. The options come
 * straight from the selected model's `variants`, plus a "Default" entry that
 * leaves the effort unset. Renders nothing when the model has no variants.
 */
export function ThinkingSelector({ variants, value, onChange }: Props) {
  if (variants.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
        >
          <span className="truncate">{value ? label(value) : "Default"}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-[140px]">
        <DropdownMenuRadioGroup
          value={value ?? DEFAULT}
          onValueChange={(v) => onChange(v === DEFAULT ? null : v)}
        >
          <DropdownMenuRadioItem value={DEFAULT}>Default</DropdownMenuRadioItem>
          {variants.map((v) => (
            <DropdownMenuRadioItem key={v} value={v}>
              {label(v)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
