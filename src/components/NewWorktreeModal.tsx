import { useEffect, useState } from "react";
import { addWorktree, listBranches } from "../lib/api";
import type { ProjectView } from "../lib/types";

interface Props {
  project: ProjectView;
  onClose: () => void;
  onCreated: (view: ProjectView) => void;
}

/** Modal to create a worktree: a new branch name + a base branch to fork from. */
export function NewWorktreeModal({ project, onClose, onCreated }: Props) {
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState<string>(project.default_branch ?? "");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listBranches(project.id)
      .then((bs) => {
        setBranches(bs);
        if (bs.length && !base) setBase(bs[0]);
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  async function create() {
    const name = branch.trim();
    if (!name || !base || busy) return;
    setBusy(true);
    setError(null);
    try {
      const view = await addWorktree(project.id, name, base);
      onCreated(view);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New worktree in {project.name}</h2>

        <label>
          New branch name
          <input
            autoFocus
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="feature/my-change"
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
        </label>

        <label>
          Base branch
          <select value={base} onChange={(e) => setBase(e.target.value)}>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>

        {error && <p className="error-text small">{error}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => void create()} disabled={busy || !branch.trim()}>
            {busy ? "Creating…" : "Create worktree"}
          </button>
        </div>
      </div>
    </div>
  );
}
