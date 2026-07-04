import { ArrowUp, Plus, Square, X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import type { ClipboardImage } from "../hooks/useClipboardImages";
import type { ContextInfo } from "../lib/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ContextRing } from "./ContextRing";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
  placeholder: string;
  /** Config pills rendered on the left of the bottom rail, after attach. */
  controls?: ReactNode;
  attachments?: ClipboardImage[];
  onRemoveAttachment?: (id: string) => void;
  /** When set, the + button opens an image picker; otherwise it's disabled. */
  onAttachFiles?: (files: File[]) => void;
  attachDisabledHint?: string;
  busy?: boolean;
  canSend: boolean;
  onSend: () => void;
  onStop?: () => void;
  /** Pass (even null) to show the context ring; omit to hide it (Home). */
  context?: ContextInfo | null;
  /** One-line keyboard hint rendered under the frame. */
  hint?: ReactNode;
}

/** A boxed keystroke for the hint line under the composer. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-b-2 border-border bg-card px-1 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

/** Rough decoded size of a base64 data URL, for the attachment chip label. */
function dataUrlKb(url: string): string {
  const b64 = url.slice(url.indexOf(",") + 1);
  const kb = Math.max(1, Math.round((b64.length * 0.75) / 1024));
  return `${kb} KB`;
}

/**
 * The shared chat message box: attachment chips, then the textarea, then a
 * bottom rail — intent on the left (attach + config pills), session state on
 * the right (context ring, send/stop). Used verbatim by both the session
 * view and Home; Home simply passes no live state.
 */
export function Composer({
  value,
  onChange,
  onKeyDown,
  onPaste,
  onBlur,
  placeholder,
  controls,
  attachments = [],
  onRemoveAttachment,
  onAttachFiles,
  attachDisabledHint = "Attach · in session",
  busy = false,
  canSend,
  onSend,
  onStop,
  context,
  hint,
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <div className="mx-auto max-w-4xl">
      <div
        className={cn(
          "relative rounded-xl border border-border bg-card transition-colors duration-150 focus-within:border-ring",
          busy && "composer-loading",
        )}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {attachments.map((a) => (
              <div
                key={a.id}
                className="group relative flex max-w-60 items-center gap-2 rounded-lg border border-border bg-secondary py-1 pl-1 pr-2.5"
              >
                <img
                  src={a.url}
                  alt={a.filename}
                  className="size-8 rounded-md border border-border object-cover"
                />
                <div className="min-w-0 leading-tight">
                  <div className="truncate text-xs">{a.filename}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {(a.mime.split("/")[1] ?? "image").toUpperCase()} ·{" "}
                    {dataUrlKb(a.url)}
                  </div>
                </div>
                {onRemoveAttachment && (
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(a.id)}
                    className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                    aria-label="Remove attachment"
                  >
                    <X className="size-2.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={onBlur}
          placeholder={placeholder}
          className="min-h-[64px] resize-none border-0 bg-transparent px-4 pt-3 text-[15px] shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex flex-wrap items-center gap-1 px-2 pb-2 pt-0.5">
          {onAttachFiles ? (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length)
                    onAttachFiles(Array.from(e.target.files));
                  e.target.value = "";
                }}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => fileInput.current?.click()}
                title="Attach images"
              >
                <Plus className="size-4" />
              </Button>
            </>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" disabled>
                  <Plus className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{attachDisabledHint}</TooltipContent>
            </Tooltip>
          )}
          {controls}
          <div className="ml-auto flex items-center gap-1.5">
            {context !== undefined && <ContextRing info={context} />}
            {busy && onStop ? (
              <Button
                size="icon-sm"
                className="bg-destructive/15 text-destructive hover:bg-destructive/25"
                onClick={onStop}
                aria-label="Stop"
              >
                <Square className="size-3.5" />
              </Button>
            ) : (
              <Button
                size="icon-sm"
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground/50 disabled:opacity-100"
                onClick={onSend}
                disabled={!canSend}
                aria-label="Send"
              >
                <ArrowUp className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
      {hint && (
        <p className="mt-1.5 text-center text-[11px] text-muted-foreground/70">
          {hint}
        </p>
      )}
    </div>
  );
}
