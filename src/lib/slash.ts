// Helpers for the chat composer's slash-command flow.

import type { CommandOption } from "./types";

export interface ParsedSlash {
  /** Command name (no leading slash). */
  name: string;
  /** Everything after the first whitespace; empty if none. */
  args: string;
}

/**
 * If `text` begins with a slash, split it into command name + remainder.
 * Returns null when the input isn't a slash command.
 */
export function parseSlash(text: string): ParsedSlash | null {
  if (!text.startsWith("/")) return null;
  const body = text.slice(1);
  const idx = body.search(/\s/);
  if (idx === -1) return { name: body, args: "" };
  return { name: body.slice(0, idx), args: body.slice(idx + 1) };
}

/**
 * Substitute `$ARGUMENTS` in a command template. When the template has no
 * placeholder, the args are appended after a blank line so trailing input
 * isn't silently dropped.
 */
export function expandTemplate(template: string, args: string): string {
  if (template.includes("$ARGUMENTS")) {
    // Use split/join to substitute every occurrence without engaging regex
    // metachar handling on `args` (replace + /g would mishandle `$&` etc.).
    return template.split("$ARGUMENTS").join(args);
  }
  return args ? `${template}\n\n${args}` : template;
}

/**
 * Whether the current composer text is in slash-name-typing state (palette
 * should show). True for `/`, `/rev`, etc.; false once whitespace appears.
 */
export function isSlashTyping(text: string): boolean {
  return text.startsWith("/") && !/\s/.test(text);
}

/**
 * Filter commands by case-insensitive prefix match on the typed name.
 * Sorts user-defined commands before skills, then alphabetically.
 */
export function filterCommands(commands: CommandOption[], query: string): CommandOption[] {
  const q = query.toLowerCase();
  return commands
    .filter((c) => c.name.toLowerCase().startsWith(q))
    .sort((a, b) => {
      const sa = a.source === "skill" ? 1 : 0;
      const sb = b.source === "skill" ? 1 : 0;
      return sa - sb || a.name.localeCompare(b.name);
    });
}
