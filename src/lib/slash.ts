// Helpers for the chat composer's slash-command flow. OpenCode expands
// `/cmd args` server-side over ACP, so this is only about the palette UI.

import type { ChatCommand } from "./types";

/**
 * Whether the current composer text is in slash-name-typing state (palette
 * should show). True for `/`, `/rev`, etc.; false once whitespace appears.
 */
export function isSlashTyping(text: string): boolean {
  return text.startsWith("/") && !/\s/.test(text);
}

/** Filter commands by case-insensitive prefix match, alphabetically sorted. */
export function filterCommands(
  commands: ChatCommand[],
  query: string,
): ChatCommand[] {
  const q = query.toLowerCase();
  return commands
    .filter((c) => c.name.toLowerCase().startsWith(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}
