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
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectUpdate {
    pub name: Option<String>,
    pub default_branch: Option<String>,
    pub default_model_key: Option<String>,
    pub prompts: Option<ProjectPrompts>,
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
}

impl Registry {
    /// Load the registry from `file`, or start empty if it doesn't exist.
    /// Worktrees are created under `worktrees_dir`.
    pub fn load(file: PathBuf, worktrees_dir: PathBuf) -> Self {
        let data = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { data: Mutex::new(data), file, worktrees_dir }
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

    /// Resolve a workspace's project root. For base workspaces this is the
    /// workspace itself; for worktrees it is the parent repo root.
    pub fn workspace_project_root(&self, workspace_id: &str) -> Option<String> {
        let data = self.data.lock().unwrap();
        let ws = data.workspaces.iter().find(|w| w.id == workspace_id)?;
        if ws.kind == WorkspaceKind::Base {
            return Some(ws.path.clone());
        }
        data.projects.iter().find(|p| p.id == ws.project_id).map(|p| p.root_path.clone())
    }

    /// Get the workspace and its project root together (used by merge/push).
    pub fn workspace_with_root(&self, workspace_id: &str) -> Option<(Workspace, String)> {
        let data = self.data.lock().unwrap();
        let ws = data.workspaces.iter().find(|w| w.id == workspace_id)?.clone();
        let root = if ws.kind == WorkspaceKind::Base {
            ws.path.clone()
        } else {
            data.projects.iter().find(|p| p.id == ws.project_id)?.root_path.clone()
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
        };
        let mut data = self.data.lock().unwrap();
        data.workspaces.push(ws.clone());
        self.persist(&data);
        Ok(ws)
    }

    /// Remove a worktree workspace (and its git worktree). Base workspaces
    /// cannot be removed this way — remove the project instead.
    pub fn remove_workspace(&self, workspace_id: &str, force: bool) -> Result<(), String> {
        let (project_id, path) = {
            let data = self.data.lock().unwrap();
            let ws = data.workspaces.iter().find(|w| w.id == workspace_id).ok_or("unknown workspace")?;
            if ws.kind == WorkspaceKind::Base {
                return Err("cannot remove the base workspace".into());
            }
            (ws.project_id.clone(), ws.path.clone())
        };
        let root = self.repo_root(&project_id).ok_or("unknown project")?;
        git::remove_worktree(&root, &path, force)?;

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
