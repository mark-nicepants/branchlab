//! Project & workspace registry.
//!
//! A Project points at a git repo. Every project has one implicit `base`
//! workspace (the repo root); worktree workspaces are added in M2. The
//! registry is persisted as JSON in the app data dir so projects survive
//! restarts — server processes are not persisted (they're re-spawned on
//! demand).

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::git;

// Default lifecycle prompts seeded into every new project. Users can override
// them per-project via the settings dialog.
const DEFAULT_INIT_WORKSPACE: &str = "Set up the new workspace.";
const DEFAULT_COMMIT: &str = "Stage all changes in this workspace with git add -A, then commit with a clear, concise conventional commit message that summarizes the diff. Do not push.";
const DEFAULT_MERGE: &str = "Merge this workspace's branch into the base/main branch of the repository. First run the git commands from this workspace directory. Then switch to the base branch in the parent repository, merge this workspace's branch into it, and push the result to origin. Confirm the merge succeeded.";
const DEFAULT_PUSH: &str =
    "First, check the git diff to see what has changed in this workspace. If there is no clear branch name, invent one that fits the changes (e.g. feature/xxx, tech/xxx, fix/xxx, refactor/xxx, or similar). Then stage the logical changes with git add, commit with a clear conventional commit message, and push the branch to the origin remote. Confirm the remote and branch name.";
const DEFAULT_CREATE_PR: &str = "Push the current workspace branch to origin and open a GitHub pull request against the base branch using gh pr create. Use a clear title and description based on the changes.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub default_branch: Option<String>,
    pub default_model_key: Option<String>,
    pub prompts: ProjectPrompts,
    /// Manual GitHub account override (`"{host}/{login}"`). `None` = auto-detect
    /// the account from this repo's `origin` remote (host + owner/org).
    #[serde(default)]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectPrompts {
    pub init_workspace: Option<String>,
    pub commit: Option<String>,
    pub merge: Option<String>,
    pub push: Option<String>,
    pub create_pr: Option<String>,
}

impl Default for ProjectPrompts {
    fn default() -> Self {
        Self {
            init_workspace: Some(DEFAULT_INIT_WORKSPACE.into()),
            commit: Some(DEFAULT_COMMIT.into()),
            merge: Some(DEFAULT_MERGE.into()),
            push: Some(DEFAULT_PUSH.into()),
            create_pr: Some(DEFAULT_CREATE_PR.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum WorkspaceKind {
    Base,
    Worktree,
    /// A context-free chat in an app-managed scratch directory — no git repo,
    /// no worktree, no project. Registered under [`QUICK_CHAT_PROJECT_ID`].
    QuickChat,
}

/// Reserved `project_id` for quick chats (they have no real project).
pub const QUICK_CHAT_PROJECT_ID: &str = "__quick__";

/// PR pipeline autofix mode, persisted per workspace so the backend supervisor
/// can drive autofix for enabled workspaces regardless of what's on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AutofixMode {
    #[default]
    Off,
    Auto,
    Super,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub project_id: String,
    pub kind: WorkspaceKind,
    pub path: String,
    /// The workspace's own branch (a generated codename like `bubbly-cheetah`
    /// for new workspaces). Doubles as the fallback display name.
    pub branch: Option<String>,
    /// Display name. AI-generated from the first chat interaction, then only
    /// changed manually. `#[serde(default)]` keeps older registries loadable.
    #[serde(default)]
    pub name: Option<String>,
    /// Branch this workspace was forked from (for the "Branched X from Y" line).
    #[serde(default)]
    pub base_branch: Option<String>,
    /// Optional prompt sent to the AI once the workspace server is ready.
    #[serde(default)]
    pub init_prompt: Option<String>,
    /// PR pipeline autofix mode (backend-driven). Persisted so background
    /// autofix survives restarts and doesn't depend on the frontend.
    #[serde(default)]
    pub autofix_mode: AutofixMode,
    /// The OpenCode session id the backend uses to drive this workspace
    /// (autofix prompts). Registered by the frontend when it creates/loads a
    /// session; the supervisor falls back to creating one for background work.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Last selected model (`provider/model`) for this workspace. Re-applied to
    /// every new engine session so a restart doesn't fall back to opencode's
    /// built-in default. `None` = global default model (or opencode's default).
    #[serde(default)]
    pub model: Option<String>,
    /// Preferred thinking level (the ACP `effort` config option) for this
    /// workspace. Re-applied to every new engine session — and after model
    /// switches — while the selected model supports it. `None` = model default.
    #[serde(default)]
    pub effort: Option<String>,
    /// PR number, when this workspace was checked out from an existing PR
    /// (the PR→workspace flow). `None` for workspaces that predate a PR.
    #[serde(default)]
    pub pr_number: Option<i64>,
    #[serde(default)]
    pub pr_url: Option<String>,
    /// Head repo `"owner/repo"` — differs from the base repo for fork PRs.
    #[serde(default)]
    pub pr_head_repo: Option<String>,
    /// A fork PR: read-only here (no push/autofix back to the fork).
    #[serde(default)]
    pub pr_is_fork: bool,
    /// Last polled CI snapshot, persisted so the UI seeds instantly on restart
    /// (previously this lived only in the supervisor's in-memory runtime).
    #[serde(default)]
    pub pr: Option<git::PrStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectUpdate {
    pub name: Option<String>,
    pub default_branch: Option<String>,
    pub default_model_key: Option<String>,
    pub prompts: Option<ProjectPrompts>,
    /// GitHub account override. `Some("")` clears it (back to auto-detect),
    /// `Some(id)` sets it, `None` leaves it unchanged.
    pub account_id: Option<String>,
}

/// A project together with its workspaces — the shape the UI consumes.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectView {
    #[serde(flatten)]
    pub project: Project,
    pub workspaces: Vec<Workspace>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RegistryData {
    projects: Vec<Project>,
    workspaces: Vec<Workspace>,
}

/// The PR facts needed to check a PR out into a workspace (from the GitHub API).
pub struct PrWorkspaceMeta {
    pub number: i64,
    pub title: String,
    pub base_ref: String,
    pub url: String,
    /// Head repo `"owner/repo"` (differs from base for fork PRs).
    pub head_repo: Option<String>,
    pub is_fork: bool,
}

fn default_branch_for(repo: &Path) -> Option<String> {
    // 1. symbolic ref (e.g. refs/remotes/origin/HEAD -> origin/main)
    if let Ok(out) = std::process::Command::new("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
        .current_dir(repo)
        .output()
    {
        if out.status.success() {
            let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Some(b) = branch.strip_prefix("origin/") {
                return Some(b.to_string());
            }
        }
    }
    // 2. known primary branches
    for candidate in ["main", "master", "develop"] {
        if git::has_branch(repo.to_str().unwrap_or(""), candidate) {
            return Some(candidate.to_string());
        }
    }
    // 3. fall back to current branch
    current_branch(repo)
}

pub struct Registry {
    data: Mutex<RegistryData>,
    file: PathBuf,
    /// App-managed directory under which worktree directories are created.
    worktrees_dir: PathBuf,
    /// App-managed directory under which quick-chat scratch dirs are created.
    quick_chats_dir: PathBuf,
}

impl Registry {
    /// Load the registry from `file`, or start empty if it doesn't exist.
    /// Worktrees are created under `worktrees_dir`, quick-chat scratch dirs
    /// under `quick_chats_dir`.
    pub fn load(file: PathBuf, worktrees_dir: PathBuf, quick_chats_dir: PathBuf) -> Self {
        let data = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { data: Mutex::new(data), file, worktrees_dir, quick_chats_dir }
    }

    fn persist(&self, data: &RegistryData) {
        if let Some(parent) = self.file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(data) {
            let _ = std::fs::write(&self.file, json);
        }
    }

    /// Register a git repo as a project (idempotent on path). Creates the
    /// implicit base workspace. Returns the project view.
    pub fn add_project(&self, root_path: &str) -> Result<ProjectView, String> {
        let canonical = std::fs::canonicalize(root_path).map_err(|e| format!("cannot access path: {e}"))?;
        if !is_git_repo(&canonical) {
            return Err("selected folder is not a git repository".into());
        }
        let root = canonical.to_string_lossy().into_owned();
        let id = id_for(&root);

        let mut data = self.data.lock().unwrap();
        if !data.projects.iter().any(|p| p.id == id) {
            let name = canonical.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| root.clone());
            data.projects.push(Project {
                id: id.clone(),
                name,
                root_path: root.clone(),
                default_branch: default_branch_for(&canonical),
                default_model_key: None,
                prompts: ProjectPrompts::default(),
                account_id: None,
            });
            data.workspaces.push(Workspace {
                id: format!("{id}-base"),
                project_id: id.clone(),
                kind: WorkspaceKind::Base,
                path: root.clone(),
                branch: current_branch(&canonical),
                name: None,
                base_branch: None,
                init_prompt: None,
                autofix_mode: AutofixMode::default(),
                session_id: None,
                model: None,
                effort: None,
                pr_number: None,
                pr_url: None,
                pr_head_repo: None,
                pr_is_fork: false,
                pr: None,
            });
            self.persist(&data);
        }
        Ok(self.view_of(&data, &id))
    }

    /// Set a workspace's display name (AI-generated once, or manual).
    pub fn rename_workspace(&self, workspace_id: &str, name: &str) {
        let mut data = self.data.lock().unwrap();
        if let Some(w) = data.workspaces.iter_mut().find(|w| w.id == workspace_id) {
            w.name = Some(name.to_string());
        }
        self.persist(&data);
    }

    /// Set a workspace's PR autofix mode (persisted).
    pub fn set_autofix_mode(&self, workspace_id: &str, mode: AutofixMode) {
        let mut data = self.data.lock().unwrap();
        if let Some(w) = data.workspaces.iter_mut().find(|w| w.id == workspace_id) {
            w.autofix_mode = mode;
        }
        self.persist(&data);
    }

    /// Persist the last polled PR snapshot for a workspace so the UI can seed
    /// its pipeline instantly on restart (before the first live poll). Only
    /// writes when the value actually changed, to avoid churning the file.
    pub fn set_workspace_pr(&self, workspace_id: &str, pr: Option<git::PrStatus>) {
        let mut data = self.data.lock().unwrap();
        if let Some(w) = data.workspaces.iter_mut().find(|w| w.id == workspace_id) {
            if w.pr != pr {
                w.pr = pr;
                self.persist(&data);
            }
        }
    }

    /// Persist a workspace's last selected model (`None` = global default).
    /// Only writes when the value actually changed, to avoid churning the file.
    pub fn set_workspace_model(&self, workspace_id: &str, model: Option<String>) {
        let mut data = self.data.lock().unwrap();
        if let Some(w) = data.workspaces.iter_mut().find(|w| w.id == workspace_id) {
            if w.model != model {
                w.model = model;
                self.persist(&data);
            }
        }
    }

    /// A workspace's persisted model, if any.
    pub fn workspace_model(&self, workspace_id: &str) -> Option<String> {
        let data = self.data.lock().unwrap();
        data.workspaces.iter().find(|w| w.id == workspace_id).and_then(|w| w.model.clone())
    }

    /// Persist a workspace's preferred thinking level (`None` = model default).
    /// Only writes when the value actually changed, to avoid churning the file.
    pub fn set_workspace_effort(&self, workspace_id: &str, effort: Option<String>) {
        let mut data = self.data.lock().unwrap();
        if let Some(w) = data.workspaces.iter_mut().find(|w| w.id == workspace_id) {
            if w.effort != effort {
                w.effort = effort;
                self.persist(&data);
            }
        }
    }

    /// A workspace's persisted thinking level, if any.
    pub fn workspace_effort(&self, workspace_id: &str) -> Option<String> {
        let data = self.data.lock().unwrap();
        data.workspaces.iter().find(|w| w.id == workspace_id).and_then(|w| w.effort.clone())
    }

    /// A project's repo root path.
    pub fn project_root(&self, project_id: &str) -> Option<String> {
        self.repo_root(project_id)
    }

    /// The GitHub account override configured for a project (`None` = auto-detect).
    pub fn project_account_id(&self, project_id: &str) -> Option<String> {
        self.data.lock().unwrap().projects.iter().find(|p| p.id == project_id).and_then(|p| p.account_id.clone())
    }

    /// Update a project's metadata and prompts.
    pub fn update_project(&self, project_id: &str, update: ProjectUpdate) -> Result<ProjectView, String> {
        let mut data = self.data.lock().unwrap();
        let project = data.projects.iter_mut().find(|p| p.id == project_id).ok_or("unknown project")?;
        if let Some(name) = update.name {
            project.name = name;
        }
        if let Some(default_branch) = update.default_branch {
            project.default_branch = Some(default_branch);
        }
        if let Some(default_model_key) = update.default_model_key {
            project.default_model_key = Some(default_model_key);
        }
        if let Some(prompts) = update.prompts {
            project.prompts = prompts;
        }
        if let Some(account_id) = update.account_id {
            project.account_id = if account_id.is_empty() { None } else { Some(account_id) };
        }
        self.persist(&data);
        Ok(self.view_of(&data, project_id))
    }

    pub fn prompts(&self, project_id: &str) -> Result<ProjectPrompts, String> {
        let data = self.data.lock().unwrap();
        let project = data.projects.iter().find(|p| p.id == project_id).ok_or("unknown project")?;
        Ok(project.prompts.clone())
    }

    pub fn remove_project(&self, project_id: &str) {
        let mut data = self.data.lock().unwrap();
        data.projects.retain(|p| p.id != project_id);
        data.workspaces.retain(|w| w.project_id != project_id);
        self.persist(&data);
    }

    pub fn list(&self) -> Vec<ProjectView> {
        let data = self.data.lock().unwrap();
        data.projects.iter().map(|p| self.view_of(&data, &p.id)).collect()
    }

    pub fn workspace_path(&self, workspace_id: &str) -> Option<String> {
        let data = self.data.lock().unwrap();
        data.workspaces.iter().find(|w| w.id == workspace_id).map(|w| w.path.clone())
    }

    /// Resolve a workspace's project root. For base workspaces (and quick
    /// chats, which have no project) this is the workspace itself; for
    /// worktrees it is the parent repo root.
    pub fn workspace_project_root(&self, workspace_id: &str) -> Option<String> {
        let data = self.data.lock().unwrap();
        let ws = data.workspaces.iter().find(|w| w.id == workspace_id)?;
        if ws.kind != WorkspaceKind::Worktree {
            return Some(ws.path.clone());
        }
        data.projects.iter().find(|p| p.id == ws.project_id).map(|p| p.root_path.clone())
    }

    /// Get the workspace and its project root together (used by merge/push).
    pub fn workspace_with_root(&self, workspace_id: &str) -> Option<(Workspace, String)> {
        let data = self.data.lock().unwrap();
        let ws = data.workspaces.iter().find(|w| w.id == workspace_id)?.clone();
        let root = if ws.kind == WorkspaceKind::Worktree {
            data.projects.iter().find(|p| p.id == ws.project_id)?.root_path.clone()
        } else {
            ws.path.clone()
        };
        Some((ws, root))
    }

    /// All workspaces across all projects (for the fleet dashboard).
    pub fn all_workspaces(&self) -> Vec<Workspace> {
        self.data.lock().unwrap().workspaces.clone()
    }

    /// Local branches of a project's repo (for the worktree base picker).
    pub fn branches(&self, project_id: &str) -> Result<Vec<String>, String> {
        let root = self.repo_root(project_id).ok_or("unknown project")?;
        git::list_branches(&root)
    }

    fn repo_root(&self, project_id: &str) -> Option<String> {
        self.data.lock().unwrap().projects.iter().find(|p| p.id == project_id).map(|p| p.root_path.clone())
    }

    /// Create a workspace: a worktree on a freshly generated branch codename
    /// (e.g. `bubbly-cheetah`) forked off `base` (or the repo's current branch
    /// when `base` is None). Returns the new workspace.
    pub fn create_workspace(
        &self,
        project_id: &str,
        base: Option<String>,
        init_prompt: Option<String>,
    ) -> Result<Workspace, String> {
        let root = self.repo_root(project_id).ok_or("unknown project")?;
        let base = match base {
            Some(b) if !b.is_empty() => b,
            _ => current_branch(Path::new(&root)).ok_or("cannot determine base branch")?,
        };

        let existing = git::list_branches(&root).unwrap_or_default();
        let branch = unique_codename(&existing);
        let dir = self.worktrees_dir.join(project_id).join(git::sanitize_branch(&branch));
        let path = dir.to_string_lossy().into_owned();

        git::add_worktree(&root, &path, &branch, &base)?;

        let ws = Workspace {
            id: id_for(&path),
            project_id: project_id.to_string(),
            kind: WorkspaceKind::Worktree,
            path,
            branch: Some(branch),
            name: None,
            base_branch: Some(base),
            init_prompt,
            autofix_mode: AutofixMode::default(),
            session_id: None,
            model: None,
            effort: None,
            pr_number: None,
            pr_url: None,
            pr_head_repo: None,
            pr_is_fork: false,
            pr: None,
        };
        let mut data = self.data.lock().unwrap();
        data.workspaces.push(ws.clone());
        self.persist(&data);
        Ok(ws)
    }

    /// Create a quick chat: an app-managed empty scratch directory (no git
    /// repo, no worktree) the agent can talk in. Persisted in the registry
    /// under the reserved `__quick__` project id so it survives restarts.
    /// `name` stays `None` so the first chat message AI-titles it.
    pub fn create_quick_chat(&self, init_prompt: Option<String>) -> Result<Workspace, String> {
        let existing: Vec<String> = {
            let data = self.data.lock().unwrap();
            data.workspaces
                .iter()
                .filter(|w| w.kind == WorkspaceKind::QuickChat)
                .filter_map(|w| Path::new(&w.path).file_name().map(|s| s.to_string_lossy().into_owned()))
                .collect()
        };
        let codename = unique_codename(&existing);
        let dir = self.quick_chats_dir.join(&codename);
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create scratch directory: {e}"))?;
        let path = dir.to_string_lossy().into_owned();

        let ws = Workspace {
            id: id_for(&path),
            project_id: QUICK_CHAT_PROJECT_ID.to_string(),
            kind: WorkspaceKind::QuickChat,
            path,
            branch: None,
            name: None,
            base_branch: None,
            init_prompt,
            autofix_mode: AutofixMode::default(),
            session_id: None,
            model: None,
            effort: None,
            pr_number: None,
            pr_url: None,
            pr_head_repo: None,
            pr_is_fork: false,
            pr: None,
        };
        let mut data = self.data.lock().unwrap();
        data.workspaces.push(ws.clone());
        self.persist(&data);
        Ok(ws)
    }

    /// Check a PR out into a fresh worktree and register it. Fetches the PR head
    /// (works for same-repo and fork PRs) into a `pr-<n>` branch, adds a worktree
    /// on it, and records the PR metadata. Reuses the same worktree machinery as
    /// `create_workspace`.
    pub fn create_workspace_from_pr(&self, project_id: &str, meta: PrWorkspaceMeta) -> Result<Workspace, String> {
        let root = self.repo_root(project_id).ok_or("unknown project")?;
        let branch = format!("pr-{}", meta.number);
        let sanitized = git::sanitize_branch(&branch);
        let dir = self.worktrees_dir.join(project_id).join(&sanitized);
        let path = dir.to_string_lossy().into_owned();
        if dir.exists() {
            return Err(format!("a workspace for PR #{} already exists", meta.number));
        }

        git::fetch_pr(&root, "origin", meta.number, &branch)?;
        git::add_worktree_existing(&root, &path, &branch)?;

        let ws = Workspace {
            id: id_for(&path),
            project_id: project_id.to_string(),
            kind: WorkspaceKind::Worktree,
            path,
            branch: Some(branch),
            name: Some(meta.title),
            base_branch: Some(meta.base_ref),
            init_prompt: None,
            autofix_mode: AutofixMode::default(),
            session_id: None,
            model: None,
            effort: None,
            pr_number: Some(meta.number),
            pr_url: Some(meta.url),
            pr_head_repo: meta.head_repo,
            pr_is_fork: meta.is_fork,
            pr: None,
        };
        let mut data = self.data.lock().unwrap();
        data.workspaces.push(ws.clone());
        self.persist(&data);
        Ok(ws)
    }

    /// Remove a workspace from the registry. For worktree workspaces the git
    /// worktree is also removed. Base workspaces are removed from the registry
    /// only (the underlying repo directory is never touched); removing the last
    /// base workspace effectively orphans its project, so callers should
    /// consider removing the project too.
    pub fn remove_workspace(&self, workspace_id: &str, force: bool) -> Result<(), String> {
        let (project_id, kind, path) = {
            let data = self.data.lock().unwrap();
            let ws = data.workspaces.iter().find(|w| w.id == workspace_id).ok_or("unknown workspace")?;
            (ws.project_id.clone(), ws.kind.clone(), ws.path.clone())
        };

        if kind == WorkspaceKind::Worktree {
            let root = self.repo_root(&project_id).ok_or("unknown project")?;
            git::remove_worktree(&root, &path, force)?;
        }
        // Quick chats own their scratch dir; delete it (only ever app-managed,
        // but keep the guard so a corrupt registry entry can't delete elsewhere).
        if kind == WorkspaceKind::QuickChat && Path::new(&path).starts_with(&self.quick_chats_dir) {
            let _ = std::fs::remove_dir_all(&path);
        }

        let mut data = self.data.lock().unwrap();
        data.workspaces.retain(|w| w.id != workspace_id);
        self.persist(&data);
        Ok(())
    }

    fn view_of(&self, data: &RegistryData, project_id: &str) -> ProjectView {
        let project = data.projects.iter().find(|p| p.id == project_id).cloned().expect("project exists");
        let workspaces = data.workspaces.iter().filter(|w| w.project_id == project_id).cloned().collect();
        ProjectView { project, workspaces }
    }
}

/// Stable id derived from the absolute path (no randomness needed; the path is
/// the natural key for both projects and worktree directories).
fn id_for(path: &str) -> String {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// A friendly `adjective-animal` codename (e.g. `bubbly-cheetah`), used as both
/// the new branch name and the initial workspace label.
fn generate_codename() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    const ADJ: &[&str] = &[
        "bubbly", "sunny", "witty", "mellow", "brave", "clever", "cosmic", "fuzzy", "jolly", "nimble", "quiet",
        "swift", "lucky", "snappy", "vivid", "zesty",
    ];
    const ANI: &[&str] = &[
        "cheetah", "otter", "falcon", "panda", "lynx", "heron", "bison", "marmot", "gecko", "walrus", "ferret",
        "badger", "magpie", "narwhal", "koala", "tapir",
    ];
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0) as usize;
    format!("{}-{}", ADJ[n % ADJ.len()], ANI[(n / 97) % ANI.len()])
}

/// A codename that doesn't collide with an existing branch.
fn unique_codename(existing: &[String]) -> String {
    let mut name = generate_codename();
    let mut suffix = 2;
    while existing.iter().any(|e| e == &name) {
        name = format!("{}-{}", generate_codename(), suffix);
        suffix += 1;
    }
    name
}

fn is_git_repo(path: &Path) -> bool {
    // A plain repo has `.git`; a worktree has a `.git` *file* pointing elsewhere.
    path.join(".git").exists()
}

fn current_branch(path: &Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!branch.is_empty()).then_some(branch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_effort_persists_and_survives_reload() {
        let dir = std::env::temp_dir().join(format!("bl-reg-effort-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("registry.json");
        let reg = Registry::load(file.clone(), dir.join("worktrees"), dir.join("quick-chats"));
        {
            let mut data = reg.data.lock().unwrap();
            data.workspaces.push(Workspace {
                id: "ws1".into(),
                project_id: "p1".into(),
                kind: WorkspaceKind::Worktree,
                path: "/tmp/x".into(),
                branch: None,
                name: None,
                base_branch: None,
                init_prompt: None,
                autofix_mode: AutofixMode::default(),
                session_id: None,
                model: None,
                effort: None,
                pr_number: None,
                pr_url: None,
                pr_head_repo: None,
                pr_is_fork: false,
                pr: None,
            });
            reg.persist(&data);
        }
        assert_eq!(reg.workspace_effort("ws1"), None);
        assert_eq!(reg.workspace_model("ws1"), None);
        reg.set_workspace_effort("ws1", Some("high".into()));
        reg.set_workspace_model("ws1", Some("anthropic/claude-opus-4-8".into()));
        assert_eq!(reg.workspace_effort("ws1").as_deref(), Some("high"));
        assert_eq!(reg.workspace_model("ws1").as_deref(), Some("anthropic/claude-opus-4-8"));
        // Survive a reload from disk (and older registries without the fields
        // stay loadable via serde(default)).
        let reg2 = Registry::load(file, dir.join("worktrees"), dir.join("quick-chats"));
        assert_eq!(reg2.workspace_effort("ws1").as_deref(), Some("high"));
        assert_eq!(reg2.workspace_model("ws1").as_deref(), Some("anthropic/claude-opus-4-8"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quick_chat_create_persist_remove() {
        let dir = std::env::temp_dir().join(format!("bl-reg-quick-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("registry.json");
        let reg = Registry::load(file.clone(), dir.join("worktrees"), dir.join("quick-chats"));

        let ws = reg.create_quick_chat(Some("hello".into())).unwrap();
        assert_eq!(ws.kind, WorkspaceKind::QuickChat);
        assert_eq!(ws.project_id, QUICK_CHAT_PROJECT_ID);
        assert_eq!(ws.name, None); // AI-titled on first message
        assert_eq!(ws.init_prompt.as_deref(), Some("hello"));
        assert!(Path::new(&ws.path).is_dir(), "scratch dir exists");
        // Its own path doubles as its "root" (no project to resolve).
        assert_eq!(reg.workspace_project_root(&ws.id).as_deref(), Some(ws.path.as_str()));

        // Survives a reload.
        let reg2 = Registry::load(file, dir.join("worktrees"), dir.join("quick-chats"));
        assert!(reg2.all_workspaces().iter().any(|w| w.id == ws.id));

        // Removal deletes the registry entry AND the scratch dir.
        reg2.remove_workspace(&ws.id, false).unwrap();
        assert!(!reg2.all_workspaces().iter().any(|w| w.id == ws.id));
        assert!(!Path::new(&ws.path).exists(), "scratch dir removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn id_for_is_stable_for_a_path() {
        let a = id_for("/Users/me/repo");
        let b = id_for("/Users/me/repo");
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn id_for_differs_between_paths() {
        assert_ne!(id_for("/a"), id_for("/b"));
    }

    #[test]
    fn unique_codename_skips_existing() {
        // Block every codename the generator could produce (it's adj-animal,
        // bounded), so the function must fall back to the suffix form.
        let blocked = (0..1000).map(|_| generate_codename()).collect::<Vec<_>>();
        let name = unique_codename(&blocked);
        assert!(!blocked.iter().any(|b| b == &name));
    }
}
