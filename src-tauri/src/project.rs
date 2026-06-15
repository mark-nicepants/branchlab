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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub default_branch: Option<String>,
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
                default_branch: current_branch(&canonical),
            });
            data.workspaces.push(Workspace {
                id: format!("{id}-base"),
                project_id: id.clone(),
                kind: WorkspaceKind::Base,
                path: root.clone(),
                branch: current_branch(&canonical),
                name: None,
                base_branch: None,
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
    pub fn create_workspace(&self, project_id: &str, base: Option<String>) -> Result<Workspace, String> {
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
