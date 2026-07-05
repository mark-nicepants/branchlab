//! GitManager — thin wrappers over the `git` CLI for worktree management.
//!
//! We shell out to `git` (rather than libgit2) because worktree support is
//! simpler and more reliable that way, and git is a hard dependency anyway.
//! Worktrees live in an app-managed directory (outside the repo tree) so they
//! never pollute the repo's status or .gitignore.

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

/// Summary of uncommitted changes in a working directory, for the fleet view.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct DiffStat {
    pub files: u32,
    pub insertions: u32,
    pub deletions: u32,
}

fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let out =
        Command::new("git").args(args).current_dir(repo).output().map_err(|e| format!("git failed to run: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Run git and return stdout regardless of exit status (e.g. `diff --no-index`
/// exits 1 when files differ, which is not an error for us).
fn git_out(repo: &str, args: &[&str]) -> String {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// Run git, returning stdout even on success but also treating "nothing to commit" as success.
fn git_allow_empty(repo: &str, args: &[&str]) -> Result<String, String> {
    let out =
        Command::new("git").args(args).current_dir(repo).output().map_err(|e| format!("git failed to run: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() && !stderr.contains("nothing to commit") && !stdout.contains("nothing to commit") {
        return Err(format!("{stdout}\n{stderr}").trim().to_string());
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

/// Check whether a branch exists locally or on any remote.
pub fn has_branch(repo: &str, branch: &str) -> bool {
    let out = git_out(repo, &["branch", "-a", "--list", branch, "--format=%(refname:short)"]);
    out.lines().any(|l| {
        let l = l.trim();
        l == branch || l.strip_prefix("origin/").is_some_and(|b| b == branch)
    })
}

/// Rename a local branch (works from inside a worktree; the ref is repo-wide).
pub fn rename_branch(repo: &str, old: &str, new: &str) -> Result<(), String> {
    git(repo, &["branch", "-m", old, new]).map(|_| ())
}

/// Whether the branch exists on `origin` as far as the local refs know (no
/// network) — true once the branch has been pushed from this clone.
pub fn remote_branch_exists(repo: &str, branch: &str) -> bool {
    git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{branch}")]).is_ok()
}

/// Local branches, current branch first.
pub fn list_branches(repo: &str) -> Result<Vec<String>, String> {
    let out = git(repo, &["branch", "--format=%(refname:short)"])?;
    let mut branches: Vec<String> = out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    if let Ok(current) = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        let current = current.trim().to_string();
        branches.sort_by_key(|b| (b != &current, b.clone()));
    }
    Ok(branches)
}

/// Create a worktree at `worktree_path` on a new branch `branch` off `base`.
pub fn add_worktree(repo: &str, worktree_path: &str, branch: &str, base: &str) -> Result<(), String> {
    if Path::new(worktree_path).exists() {
        return Err(format!("worktree path already exists: {worktree_path}"));
    }
    git(repo, &["worktree", "add", "-b", branch, worktree_path, base])?;
    Ok(())
}

/// Fetch a PR's head commit into a new local branch. Works for both same-repo
/// and fork PRs: GitHub exposes every PR's head under the base repo's
/// `refs/pull/<n>/head`, so we always fetch from `remote` (typically origin).
pub fn fetch_pr(repo: &str, remote: &str, number: i64, local_branch: &str) -> Result<(), String> {
    let refspec = format!("pull/{number}/head:{local_branch}");
    git(repo, &["fetch", "--force", remote, &refspec])?;
    Ok(())
}

/// Add a worktree checked out to an *existing* local branch (unlike
/// `add_worktree`, which creates a new branch off a base).
pub fn add_worktree_existing(repo: &str, worktree_path: &str, branch: &str) -> Result<(), String> {
    if Path::new(worktree_path).exists() {
        return Err(format!("worktree path already exists: {worktree_path}"));
    }
    git(repo, &["worktree", "add", worktree_path, branch])?;
    Ok(())
}

/// Remove a worktree. `force` is required if it has uncommitted changes.
pub fn remove_worktree(repo: &str, worktree_path: &str, force: bool) -> Result<(), String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(worktree_path);
    git(repo, &args)?;
    Ok(())
}

/// Uncommitted change summary: changed/untracked file count (porcelain) plus
/// insertions/deletions (tracked via numstat vs HEAD, untracked counted as
/// whole-file lines) — matching the totals shown in the Changes view.
pub fn diff_stat(path: &str) -> DiffStat {
    let mut stat = DiffStat::default();

    if let Ok(status) = git(path, &["status", "--porcelain"]) {
        stat.files = status.lines().filter(|l| !l.trim().is_empty()).count() as u32;
    }

    if let Ok(numstat) = git(path, &["diff", "--numstat", "HEAD"]) {
        for line in numstat.lines() {
            let mut cols = line.split_whitespace();
            // Binary files show "-"; treat as 0.
            stat.insertions += cols.next().and_then(|c| c.parse::<u32>().ok()).unwrap_or(0);
            stat.deletions += cols.next().and_then(|c| c.parse::<u32>().ok()).unwrap_or(0);
        }
    }

    // Untracked files aren't in `diff --numstat`; count their lines as
    // insertions so the totals match the Changes view (which lists them too).
    for file in git_out(path, &["ls-files", "--others", "--exclude-standard"]).lines() {
        if file.is_empty() {
            continue;
        }
        stat.insertions +=
            std::fs::read_to_string(Path::new(path).join(file)).map(|s| s.lines().count() as u32).unwrap_or(0);
    }

    stat
}

/// One changed file in a working tree, relative to a comparison ref.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileChange {
    pub path: String,
    /// "modified" | "added" | "deleted" | "renamed" | "untracked"
    pub status: String,
    pub insertions: u32,
    pub deletions: u32,
}

/// List changed files in `repo` compared to `against` (e.g. "HEAD" for local
/// working-tree changes, or a base branch). Untracked files are included.
pub fn changes(repo: &str, against: &str) -> Vec<FileChange> {
    use std::collections::HashMap;
    let mut map: HashMap<String, FileChange> = HashMap::new();

    for line in git_out(repo, &["diff", "--numstat", against]).lines() {
        let mut c = line.split('\t');
        let ins = c.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        let del = c.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        if let Some(path) = c.next() {
            map.insert(
                path.to_string(),
                FileChange { path: path.to_string(), status: "modified".into(), insertions: ins, deletions: del },
            );
        }
    }

    for line in git_out(repo, &["diff", "--name-status", against]).lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        let (Some(code), Some(path)) = (parts.first(), parts.last()) else { continue };
        if path.is_empty() {
            continue;
        }
        let status = match code.chars().next().unwrap_or('M') {
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            _ => "modified",
        };
        map.entry(path.to_string())
            .or_insert_with(|| FileChange {
                path: path.to_string(),
                status: status.into(),
                insertions: 0,
                deletions: 0,
            })
            .status = status.into();
    }

    for path in git_out(repo, &["ls-files", "--others", "--exclude-standard"]).lines() {
        if path.is_empty() {
            continue;
        }
        let ins = std::fs::read_to_string(Path::new(repo).join(path)).map(|s| s.lines().count() as u32).unwrap_or(0);
        map.insert(
            path.to_string(),
            FileChange { path: path.to_string(), status: "untracked".into(), insertions: ins, deletions: 0 },
        );
    }

    let mut v: Vec<FileChange> = map.into_values().collect();
    v.sort_by(|a, b| a.path.cmp(&b.path));
    v
}

/// Unified diff for a single file vs `against`; falls back to a /dev/null diff
/// for untracked files.
pub fn file_diff(repo: &str, file: &str, against: &str) -> String {
    let out = git_out(repo, &["diff", against, "--", file]);
    if !out.trim().is_empty() {
        return out;
    }
    git_out(repo, &["diff", "--no-index", "--", "/dev/null", file])
}

/// All files in the working tree (tracked + untracked, respecting .gitignore),
/// sorted — for the file-tree browser.
pub fn list_files(repo: &str) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for args in [&["ls-files"][..], &["ls-files", "--others", "--exclude-standard"][..]] {
        for line in git_out(repo, args).lines() {
            if !line.is_empty() {
                set.insert(line.to_string());
            }
        }
    }
    set.into_iter().collect()
}

/// Contents of a single file, for the in-app viewer.
#[derive(Debug, Clone, Serialize)]
pub struct FileContent {
    pub path: String,
    /// UTF-8 text (lossy). Empty when `binary` is true.
    pub content: String,
    /// File looks binary (a NUL byte in the first 8 KiB) — `content` is empty.
    pub binary: bool,
    /// File exceeded the size cap and `content` holds only the first chunk.
    pub truncated: bool,
    /// File size on disk, in bytes.
    pub size: u64,
}

/// Largest file we'll load into the viewer; bigger files are truncated.
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;

/// Read a workspace file for the in-app viewer. `file` is a repo-relative path
/// (as produced by `list_files`); paths escaping the repo are rejected.
pub fn read_file(repo: &str, file: &str) -> Result<FileContent, String> {
    if file.split(['/', '\\']).any(|seg| seg == "..") {
        return Err("path escapes the workspace".into());
    }
    let full = Path::new(repo).join(file);
    let size = std::fs::metadata(&full).map_err(|e| e.to_string())?.len();
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;

    // Binary heuristic: a NUL byte in the first 8 KiB (same as git's).
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Ok(FileContent { path: file.into(), content: String::new(), binary: true, truncated: false, size });
    }

    let truncated = bytes.len() > MAX_FILE_BYTES;
    let slice = &bytes[..bytes.len().min(MAX_FILE_BYTES)];
    Ok(FileContent {
        path: file.into(),
        content: String::from_utf8_lossy(slice).into_owned(),
        binary: false,
        truncated,
        size,
    })
}

/// Discard a file's local changes: restore it to HEAD if tracked, otherwise
/// remove the untracked/new file from disk.
pub fn discard_file(repo: &str, file: &str) -> Result<(), String> {
    let in_head = git(repo, &["cat-file", "-e", &format!("HEAD:{file}")]).is_ok();
    if in_head {
        git(repo, &["restore", "--source=HEAD", "--staged", "--worktree", "--", file])?;
    } else {
        let _ = git(repo, &["rm", "--cached", "--force", "--", file]);
        let _ = std::fs::remove_file(Path::new(repo).join(file));
    }
    Ok(())
}

/// Sanitize a branch name into a single safe path segment (feature/x -> feature-x).
pub fn sanitize_branch(branch: &str) -> String {
    branch.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect()
}

/// Status of a git remote for `push`/`pr` checks.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

/// List configured remotes with their URLs.
pub fn list_remotes(repo: &str) -> Result<Vec<RemoteInfo>, String> {
    let out = git(repo, &["remote", "-v"])?;
    let mut seen = std::collections::HashSet::new();
    let mut remotes = Vec::new();
    for line in out.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let Some(url) = parts.next() else { continue };
        if !seen.insert(name.to_string()) {
            continue;
        }
        remotes.push(RemoteInfo { name: name.to_string(), url: url.to_string() });
    }
    Ok(remotes)
}

/// Current branch in a repo.
pub fn current_branch(repo: &str) -> Result<String, String> {
    let out = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = out.trim().to_string();
    if branch.is_empty() {
        return Err("not on a branch".into());
    }
    Ok(branch)
}

/// Resolve a working directory's actual git directory. For a worktree this is
/// `<repo>/.git/worktrees/<name>` (NOT the worktree's own dir), which is where
/// commits/checkouts land — the filesystem watcher must watch this too so the
/// changed-files count clears after an in-worktree commit.
pub fn resolve_git_dir(repo: &str) -> Option<String> {
    let out = git(repo, &["rev-parse", "--absolute-git-dir"]).ok()?;
    let dir = out.trim().to_string();
    (!dir.is_empty()).then_some(dir)
}

/// Stage all changes and commit with the supplied message.
pub fn commit_all(repo: &str, message: &str) -> Result<String, String> {
    git(repo, &["add", "-A"])?;
    let out = git_allow_empty(repo, &["commit", "-m", message])?;
    if out.contains("nothing to commit") {
        return Err("nothing to commit".into());
    }
    Ok(out)
}

/// Merge this branch into the base branch using `git checkout base && git merge branch`.
/// Returns a description of the result (fast-forward or merge commit).
pub fn merge_into_base(repo: &str, branch: &str, base: &str) -> Result<String, String> {
    // Stash any dirty state in the base worktree before switching.
    let stash = git(repo, &["stash", "push", "-u", "-m", "branchlab-auto-stash"]).ok();
    // Save where we are so we can return after the merge.
    let original = current_branch(repo)?;

    git(repo, &["checkout", base]).inspect_err(|_| {
        if stash.is_some() {
            let _ = git(repo, &["stash", "pop"]);
        }
    })?;

    let result = git(repo, &["merge", "--no-edit", branch]).map_err(|e| {
        let _ = git(repo, &["checkout", &original]);
        if stash.is_some() {
            let _ = git(repo, &["stash", "pop"]);
        }
        format!("merge failed: {e}")
    })?;

    // Switch back to the original branch and restore stashed changes.
    let _ = git(repo, &["checkout", &original]);
    if stash.is_some() {
        let _ = git(repo, &["stash", "pop"]);
    }

    let summary = if result.contains("Fast-forward") {
        format!("Fast-forward merged `{branch}` into `{base}`.")
    } else {
        format!("Merged `{branch}` into `{base}`.")
    };
    Ok(summary)
}

/// Push `branch` to `remote`. The remote is assumed to exist (typically `origin`).
pub fn push_branch(repo: &str, remote: &str, branch: &str) -> Result<String, String> {
    let out = git(repo, &["push", "-u", remote, branch])?;
    Ok(out)
}

/// One CI check on a pull request, normalized from `gh`'s `statusCheckRollup`
/// (which mixes GitHub Actions `CheckRun`s and legacy `StatusContext`s).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PrCheck {
    pub name: String,
    /// Coarse bucket the UI colors by: "success" | "failure" | "pending" | "skipped".
    pub bucket: String,
    /// Raw upstream state/conclusion, for display on hover.
    pub state: String,
    /// Link to the check's details (logs), when provided.
    pub url: Option<String>,
    /// Owning workflow name (Actions only), when provided.
    pub workflow: Option<String>,
}

/// A pull request's CI state for one branch. `None` from `pr_status` means no
/// PR exists for the branch (as opposed to a `gh`/auth error, which is `Err`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PrStatus {
    pub number: i64,
    pub url: String,
    /// PR state: "OPEN" | "MERGED" | "CLOSED".
    pub state: String,
    pub head_branch: String,
    /// Head commit SHA — used to dedupe autofix triggers per commit.
    pub head_sha: String,
    pub checks: Vec<PrCheck>,
    /// Rollup over `checks`: "success" | "failure" | "pending" | "none".
    pub rollup: String,
}

/// Map a raw CheckRun conclusion / StatusContext state to our coarse bucket.
fn check_bucket(raw: &str) -> &'static str {
    match raw.to_ascii_uppercase().as_str() {
        "SUCCESS" | "NEUTRAL" => "success",
        "SKIPPED" => "skipped",
        "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" | "ERROR" => "failure",
        // QUEUED / IN_PROGRESS / PENDING / WAITING / REQUESTED / EXPECTED / "" …
        _ => "pending",
    }
}

/// Fold a `statusCheckRollup` context list into normalized `PrCheck`s + a
/// coarse rollup. Shared by the legacy `gh` path and the GraphQL API path — the
/// context objects have the same shape in both (the GraphQL
/// `StatusCheckRollupContext` union: `CheckRun` | `StatusContext`).
pub fn parse_rollup(contexts: &[serde_json::Value]) -> (Vec<PrCheck>, String) {
    let mut checks = Vec::new();
    for c in contexts {
        // CheckRun (GitHub Actions) vs StatusContext (legacy commit status).
        let is_status_context = c.get("__typename").and_then(|t| t.as_str()) == Some("StatusContext");
        let (name, raw_state, url, workflow) = if is_status_context {
            (
                c.get("context").and_then(|x| x.as_str()).unwrap_or("check").to_string(),
                c.get("state").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                c.get("targetUrl").and_then(|x| x.as_str()).map(str::to_string),
                None,
            )
        } else {
            // For a CheckRun, an unfinished run has an empty conclusion; fall
            // back to its status (QUEUED/IN_PROGRESS) so it buckets as pending.
            let status = c.get("status").and_then(|x| x.as_str()).unwrap_or("");
            let conclusion = c.get("conclusion").and_then(|x| x.as_str()).unwrap_or("");
            let raw = if conclusion.is_empty() { status } else { conclusion };
            (
                c.get("name").and_then(|x| x.as_str()).unwrap_or("check").to_string(),
                raw.to_string(),
                c.get("detailsUrl").and_then(|x| x.as_str()).map(str::to_string),
                c.get("workflowName").and_then(|x| x.as_str()).map(str::to_string),
            )
        };
        checks.push(PrCheck { name, bucket: check_bucket(&raw_state).to_string(), state: raw_state, url, workflow });
    }

    let rollup = if checks.is_empty() {
        "none"
    } else if checks.iter().any(|c| c.bucket == "pending") {
        "pending"
    } else if checks.iter().any(|c| c.bucket == "failure") {
        "failure"
    } else {
        "success"
    }
    .to_string();

    (checks, rollup)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_branch_replaces_unsafe_chars() {
        assert_eq!(sanitize_branch("feature/x"), "feature-x");
        assert_eq!(sanitize_branch("fix: bug (urgent)"), "fix--bug--urgent-");
        assert_eq!(sanitize_branch("keep-_underscore"), "keep-_underscore");
    }

    /// A throwaway directory under the OS temp dir, removed on drop.
    struct TmpDir(std::path::PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("branchlab-test-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            TmpDir(dir)
        }
        fn write(&self, name: &str, bytes: &[u8]) {
            std::fs::write(self.0.join(name), bytes).unwrap();
        }
        fn repo(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn read_file_returns_text_contents() {
        let tmp = TmpDir::new("text");
        tmp.write("hello.txt", b"line one\nline two\n");
        let f = read_file(tmp.repo(), "hello.txt").unwrap();
        assert!(!f.binary);
        assert!(!f.truncated);
        assert_eq!(f.content, "line one\nline two\n");
        assert_eq!(f.size, 18);
    }

    #[test]
    fn read_file_flags_binary() {
        let tmp = TmpDir::new("binary");
        tmp.write("blob.bin", &[0x00, 0x01, 0x02, 0xff]);
        let f = read_file(tmp.repo(), "blob.bin").unwrap();
        assert!(f.binary);
        assert!(f.content.is_empty());
    }

    #[test]
    fn read_file_rejects_path_traversal() {
        let tmp = TmpDir::new("escape");
        assert!(read_file(tmp.repo(), "../secrets").is_err());
    }
}
