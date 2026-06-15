//! GitManager — thin wrappers over the `git` CLI for worktree management.
//!
//! We shell out to `git` (rather than libgit2) because worktree support is
//! simpler and more reliable that way, and git is a hard dependency anyway.
//! Worktrees live in an app-managed directory (outside the repo tree) so they
//! never pollute the repo's status or .gitignore.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

/// Summary of uncommitted changes in a working directory, for the fleet view.
#[derive(Debug, Clone, Default, Serialize)]
pub struct DiffStat {
    pub files: u32,
    pub insertions: u32,
    pub deletions: u32,
}

fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("git failed to run: {e}"))?;
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
/// tracked insertions/deletions (numstat vs HEAD).
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

    stat
}

/// One changed file in a working tree, relative to a comparison ref.
#[derive(Debug, Clone, Serialize)]
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
            .or_insert_with(|| FileChange { path: path.to_string(), status: status.into(), insertions: 0, deletions: 0 })
            .status = status.into();
    }

    for path in git_out(repo, &["ls-files", "--others", "--exclude-standard"]).lines() {
        if path.is_empty() {
            continue;
        }
        let ins = std::fs::read_to_string(Path::new(repo).join(path))
            .map(|s| s.lines().count() as u32)
            .unwrap_or(0);
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
    branch
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}
