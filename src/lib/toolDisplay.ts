// Protocol → presentation mapping for the transcript's step rows.
//
// Every step an agent takes collapses to one line with a fixed grammar —
// glyph · verb · object · outcome — and this module owns the mapping from the
// wire shape (`ToolBlock`) to those parts. It is deliberately data-only (no
// JSX): ChatMessage.tsx renders what these return.
//
// The contract that matters: **it must never crash on an unknown kind.** Tool
// names come from two non-exhaustive sources (ACP `ToolKind`-derived names and
// opencode's own tool names) and `input` is `unknown` — a shape we have not
// seen must degrade to a generic row, never throw.

import {
  Bot,
  FileText,
  Globe,
  MoveRight,
  Pencil,
  Search,
  Terminal,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { synthesizeDiff } from "./diff";
import type { DiffBlock, ToolBlock } from "./types";

/** The coarse family a tool belongs to; drives the outcome slot and the
 *  expanded payload. Unknown tools land in "other". */
export type ToolKind =
  "read" | "edit" | "execute" | "search" | "fetch" | "task" | "other";

export interface ToolDescriptor {
  Icon: LucideIcon;
  verb: string;
  obj: string;
  kind: ToolKind;
}

/** Elapsed time for a step/turn footer. Sub-50ms renders as "" (the caller
 *  treats the empty string as "don't show a duration"). */
export function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 0.05) return "";
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** +added/−removed line counts for a diff (synthesized from old/new text).
 *  `synthesizeDiff` emits one `@@` header followed by one prefixed line per
 *  source line, so the header is dropped and everything after it counts —
 *  a `+++`/`---` prefix guard would silently swallow real content lines that
 *  start with `--`/`++` (YAML separators, markdown rules). */
export function diffStats(diff: DiffBlock): { add: number; del: number } {
  const unified = synthesizeDiff(diff.oldText ?? "", diff.newText);
  let add = 0;
  let del = 0;
  for (const line of unified.split("\n").slice(1)) {
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/** `input` is `unknown` on the wire — narrow it without trusting it. */
const fields = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};

/** The per-kind step descriptor: icon + verb + object for the collapsed line.
 *  Matches both ACP ToolKind-derived names and opencode's own tool names, and
 *  falls back gracefully — the protocol is non-exhaustive by design. */
export function describeTool(block: ToolBlock): ToolDescriptor {
  const input = fields(block.input);
  const file =
    str(input.filePath) ?? str(input.file) ?? str(input.path) ?? undefined;
  const title = block.title ?? "";
  switch (block.name) {
    case "read":
      return { Icon: FileText, verb: "Read", obj: file ?? title, kind: "read" };
    case "edit":
    case "multiedit":
    case "patch":
      return { Icon: Pencil, verb: "Edited", obj: file ?? title, kind: "edit" };
    case "write":
      return { Icon: Pencil, verb: "Wrote", obj: file ?? title, kind: "edit" };
    case "bash":
    case "shell":
    case "run":
    case "execute":
      return {
        Icon: Terminal,
        verb: "Ran",
        obj: str(input.command) ?? str(input.cmd) ?? title,
        kind: "execute",
      };
    case "search":
    case "grep":
    case "glob":
    case "rg":
      return {
        Icon: Search,
        verb: "Searched",
        obj: str(input.pattern) ?? str(input.query) ?? str(input.glob) ?? title,
        kind: "search",
      };
    case "list":
    case "ls":
      return {
        Icon: Search,
        verb: "Listed",
        obj: file ?? title,
        kind: "search",
      };
    case "fetch":
    case "webfetch":
      return {
        Icon: Globe,
        verb: "Fetched",
        obj: str(input.url) ?? title,
        kind: "fetch",
      };
    case "task":
    case "agent":
    case "subagent":
      return {
        Icon: Bot,
        verb: "Subagent",
        obj: str(input.description) ?? str(input.prompt) ?? title,
        kind: "task",
      };
    case "delete":
    case "rm":
      return {
        Icon: Trash2,
        verb: "Deleted",
        obj: file ?? title,
        kind: "other",
      };
    case "move":
    case "mv":
      return {
        Icon: MoveRight,
        verb: "Moved",
        obj: file ?? title,
        kind: "other",
      };
    default:
      return {
        Icon: Wrench,
        verb: block.name.charAt(0).toUpperCase() + block.name.slice(1),
        obj: title,
        kind: "other",
      };
  }
}

/** The right-aligned outcome slot on a collapsed step line: numbers, never
 *  sentences. `null` = the step has nothing to report. */
export type ToolOutcome =
  | { type: "diff"; add: number; del: number }
  | { type: "results"; count: number }
  | { type: "line"; line: number }
  | null;

export function toolOutcome(block: ToolBlock, kind: ToolKind): ToolOutcome {
  if (kind === "edit" && block.diff) {
    return { type: "diff", ...diffStats(block.diff) };
  }
  if (kind === "search" && block.output != null) {
    const count = block.output.split("\n").filter((l) => l.trim()).length;
    return { type: "results", count };
  }
  if (kind === "read") {
    const line = block.locations?.find((l) => l.line != null)?.line;
    if (line != null) return { type: "line", line };
  }
  return null;
}
