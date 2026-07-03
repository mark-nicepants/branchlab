// Shared helpers for presenting the model catalog (provider grouping + short
// labels), used by both the composer ModelSelector and the Models settings tab.

/** The minimal shape both an ACP `ConfigChoice` and a cached catalog entry share. */
export interface ModelEntry {
  value: string;
  name: string;
  group?: string | null;
}

/** Provider label for a model: its ACP group, else the name/value prefix. */
export function providerOf(c: ModelEntry): string {
  if (c.group) return c.group;
  const nameSlash = c.name.lastIndexOf("/");
  if (nameSlash > 0) return c.name.slice(0, nameSlash);
  const valSlash = c.value.indexOf("/");
  return valSlash > 0 ? c.value.slice(0, valSlash) : "Models";
}

/** Display label without the provider prefix ("Kimi for Coding/Kimi K2.7 Code"
 *  → "Kimi K2.7 Code") — the provider is already the group heading. */
export function shortName(name: string): string {
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1).trim() : name;
}

/** Group entries by provider, preserving input order. */
export function groupByProvider<T extends ModelEntry>(
  entries: T[],
): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const c of entries) {
    const key = providerOf(c);
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  return [...groups.entries()];
}
