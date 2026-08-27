// A reusable markdown textarea: formatting toolbar (theme-token styled),
// write/preview toggle, and GFM preview rendered with the same
// `markdown-content` styles the chat transcript uses.
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bold,
  Code,
  Heading2,
  Italic,
  Link2,
  List,
  ListChecks,
} from "lucide-react";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Applied to the textarea / preview pane (e.g. sizing). */
  className?: string;
}

/** One toolbar action: wrap the selection (or insert a placeholder). */
interface Format {
  icon: typeof Bold;
  title: string;
  prefix: string;
  suffix: string;
  /** Inserted when nothing is selected. */
  placeholder: string;
  /** Line-based: prefix each selected line instead of wrapping. */
  perLine?: boolean;
}

const FORMATS: Format[] = [
  { icon: Bold, title: "Bold", prefix: "**", suffix: "**", placeholder: "bold" },
  { icon: Italic, title: "Italic", prefix: "_", suffix: "_", placeholder: "italic" },
  { icon: Code, title: "Code", prefix: "`", suffix: "`", placeholder: "code" },
  { icon: Heading2, title: "Heading", prefix: "## ", suffix: "", placeholder: "Heading", perLine: true },
  { icon: List, title: "Bullet list", prefix: "- ", suffix: "", placeholder: "item", perLine: true },
  { icon: ListChecks, title: "Task list", prefix: "- [ ] ", suffix: "", placeholder: "todo", perLine: true },
  { icon: Link2, title: "Link", prefix: "[", suffix: "](url)", placeholder: "title" },
];

export function MarkdownEditor({ value, onChange, placeholder, className }: Props) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const ref = useRef<HTMLTextAreaElement>(null);

  const apply = (f: Format) => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    const selected = value.slice(start, end) || f.placeholder;
    const inserted = f.perLine
      ? selected
          .split("\n")
          .map((l) => f.prefix + l)
          .join("\n") + f.suffix
      : f.prefix + selected + f.suffix;
    onChange(value.slice(0, start) + inserted + value.slice(end));
    // Restore focus with the inserted text selected, so chained formatting works.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start, start + inserted.length);
    });
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center gap-1 rounded-t-md border border-b-0 border-input bg-muted/40 px-1.5 py-1">
        {FORMATS.map((f) => (
          <button
            key={f.title}
            type="button"
            title={f.title}
            onClick={() => apply(f)}
            disabled={mode === "preview"}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <f.icon className="size-3.5" />
          </button>
        ))}
        <div className="flex-1" />
        <Segmented>
          <SegmentedItem active={mode === "write"} onClick={() => setMode("write")}>
            Write
          </SegmentedItem>
          <SegmentedItem
            active={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            Preview
          </SegmentedItem>
        </Segmented>
      </div>
      {mode === "write" ? (
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="min-h-0 flex-1 resize-none rounded-t-none text-sm"
        />
      ) : (
        <div className="markdown-content min-h-0 flex-1 overflow-y-auto rounded-b-md border border-input px-3 py-2 text-sm">
          {value.trim() ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
          ) : (
            <span className="text-muted-foreground">Nothing to preview.</span>
          )}
        </div>
      )}
    </div>
  );
}
