import type { EnvReport } from "../lib/types";

interface Props {
  env: EnvReport;
  onRecheck: () => void;
  rechecking: boolean;
}

/**
 * Shown when a required external tool is missing. OpenScope does not bundle
 * `opencode` in the MVP, so we guide the user to install it and offer a
 * re-check rather than failing silently.
 */
export function Onboarding({ env, onRecheck, rechecking }: Props) {
  return (
    <div className="screen center">
      <div className="onboarding">
        <h1>Welcome to OpenScope</h1>
        <p className="muted">
          OpenScope drives the <code>opencode</code> CLI and uses <code>git</code> for
          worktrees. Let's make sure both are installed.
        </p>

        <ul className="checklist">
          <ToolRow
            name="opencode"
            status={env.opencode}
            installHint="curl -fsSL https://opencode.ai/install | bash"
          />
          <ToolRow
            name="git"
            status={env.git}
            installHint="xcode-select --install   (macOS)"
          />
        </ul>

        <button className="primary" onClick={onRecheck} disabled={rechecking}>
          {rechecking ? "Checking…" : "Re-check"}
        </button>
      </div>
    </div>
  );
}

function ToolRow({
  name,
  status,
  installHint,
}: {
  name: string;
  status: EnvReport["opencode"];
  installHint: string;
}) {
  return (
    <li className={status.found ? "ok" : "missing"}>
      <span className="badge">{status.found ? "✓" : "✗"}</span>
      <div className="tool-info">
        <strong>{name}</strong>
        {status.found ? (
          <span className="muted">
            {status.version ?? "found"} · <code>{status.path}</code>
          </span>
        ) : (
          <span className="muted">
            Not found on PATH. Install with: <code>{installHint}</code>
          </span>
        )}
      </div>
    </li>
  );
}
