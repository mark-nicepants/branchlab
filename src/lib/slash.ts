// Helpers for the chat composer's slash-command flow.

import type { CommandOption } from "./types";

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
export function filterCommands(
  commands: CommandOption[],
  query: string,
): CommandOption[] {
  const q = query.toLowerCase();
  return commands
    .filter((c) => c.name.toLowerCase().startsWith(q))
    .sort((a, b) => {
      const sa = a.source === "skill" ? 1 : 0;
      const sb = b.source === "skill" ? 1 : 0;
      return sa - sb || a.name.localeCompare(b.name);
    });
}
