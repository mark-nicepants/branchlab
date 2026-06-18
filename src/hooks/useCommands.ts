import { useEffect, useState } from "react";
import type { OpencodeClient } from "../lib/opencode";
import type { CommandOption } from "../lib/types";

/**
 * Fetch the workspace server's slash commands once per session and cache them.
 * Commands don't change at runtime, so we don't poll. Returns the latest
 * snapshot plus a manual refresh in case the user edits .opencode/command/ and
 * wants to pick up the change without a restart.
 */
export function useCommands(client: OpencodeClient | null) {
  const [commands, setCommands] = useState<CommandOption[]>([]);

  useEffect(() => {
    if (!client) {
      setCommands([]);
      return;
    }
    let cancelled = false;
    client
      .listCommands()
      .then((list) => {
        if (!cancelled) setCommands(list);
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const refresh = () => {
    if (!client) return;
    client.listCommands().then(setCommands).catch(() => {});
  };

  return { commands, refresh };
}
