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

/// Sanitize a branch name into a single safe path segment (feature/x -> feature-x).
pub fn sanitize_branch(branch: &str) -> String {
    branch
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}
