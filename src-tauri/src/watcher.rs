//! Filesystem watcher that pushes git state to the UI.
//!
//! Replaces the frontend's 4s `workspace_diff_stat` / `workspace_changes`
//! polling. For every watched workspace we watch the working tree AND its
//! resolved git dir (so an in-worktree commit — which only touches
//! `<repo>/.git/worktrees/<name>` — still clears the changed-files count).
//! Changes are debounced, recomputed, deduped against the last emit, and
//! pushed as a single consolidated `workspace:git` event. A slow safety
//! re-scan covers any missed FSEvents. This module is the sole emitter of
//! `workspace:git`. See AGENTS.md "Architecture & boundaries".

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{recommended_watcher, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::git::{self, DiffStat, FileChange};

/// Quiet window after the last fs event before we recompute.
const DEBOUNCE: Duration = Duration::from_millis(300);
/// Safety re-scan cadence (covers dropped/missed fs events).
const RESCAN_INTERVAL: Duration = Duration::from_secs(45);

/// Consolidated git-state payload for one workspace (`workspace:git` event).
/// `changes` is populated only for the active workspace (the heavier query);
/// other workspaces get just the badge-level `diff_stat`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitPayload {
    pub workspace_id: String,
    pub diff_stat: DiffStat,
    pub changes: Option<Vec<FileChange>>,
    /// The branch actually checked out in the working tree. The agent can
    /// rename/switch branches inside a workspace, so the registry codename
    /// goes stale; this keeps the UI (and, via persistence, the registry)
    /// tracking reality. `None` on detached HEAD or transient git failure.
    pub branch: Option<String>,
}

struct WatchEntry {
    path: PathBuf,
    git_dir: Option<PathBuf>,
    /// Last payload emitted, for no-op suppression.
    last: Option<GitPayload>,
}

struct Inner {
    app: AppHandle,
    watcher: Mutex<RecommendedWatcher>,
    entries: Mutex<HashMap<String, WatchEntry>>,
    active: Mutex<Option<String>>,
}

#[derive(Clone)]
pub struct GitWatcher {
    inner: Arc<Inner>,
}

impl GitWatcher {
    pub fn new(app: AppHandle) -> Self {
        let (tx, rx) = channel::<PathBuf>();
        let watcher = recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                for p in event.paths {
                    let _ = tx.send(p);
                }
            }
        })
        .expect("create filesystem watcher");

        let inner = Arc::new(Inner {
            app,
            watcher: Mutex::new(watcher),
            entries: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
        });

        // Debounce/coalesce worker.
        {
            let inner = Arc::clone(&inner);
            std::thread::spawn(move || debounce_loop(inner, rx));
        }
        // Safety re-scan worker.
        {
            let inner = Arc::clone(&inner);
            std::thread::spawn(move || loop {
                std::thread::sleep(RESCAN_INTERVAL);
                let ids: Vec<String> = inner.entries.lock().unwrap().keys().cloned().collect();
                for id in ids {
                    inner.recompute_and_emit(&id);
                }
            });
        }

        Self { inner }
    }

    /// Start watching a workspace's working tree + git dir.
    pub fn watch(&self, workspace_id: &str, path: &str) {
        let path_buf = PathBuf::from(path);
        let git_dir = git::resolve_git_dir(path).map(PathBuf::from);
        {
            let mut w = self.inner.watcher.lock().unwrap();
            let _ = w.watch(&path_buf, RecursiveMode::Recursive);
            if let Some(gd) = &git_dir {
                // A worktree's git dir lives outside the working tree; watch it
                // so commits register. (For a base repo it's inside `path` and
                // already covered — a duplicate watch just errors harmlessly.)
                let _ = w.watch(gd, RecursiveMode::Recursive);
            }
        }
        self.inner
            .entries
            .lock()
            .unwrap()
            .insert(workspace_id.to_string(), WatchEntry { path: path_buf, git_dir, last: None });
        // Emit an initial snapshot so the UI isn't blank until the first change.
        self.inner.recompute_and_emit(workspace_id);
    }

    /// Stop watching a workspace (e.g. it was removed).
    pub fn unwatch(&self, workspace_id: &str) {
        if let Some(entry) = self.inner.entries.lock().unwrap().remove(workspace_id) {
            let mut w = self.inner.watcher.lock().unwrap();
            let _ = w.unwatch(&entry.path);
            if let Some(gd) = &entry.git_dir {
                let _ = w.unwatch(gd);
            }
        }
    }

    /// Set the active workspace (the one that also gets the full `changes`
    /// list). Triggers an immediate snapshot for it.
    pub fn set_active(&self, workspace_id: Option<String>) {
        *self.inner.active.lock().unwrap() = workspace_id.clone();
        if let Some(id) = workspace_id {
            self.inner.recompute_and_emit(&id);
        }
    }

    /// Force a recompute + emit for one workspace (e.g. after `discard_file`).
    pub fn refresh(&self, workspace_id: &str) {
        self.inner.recompute_and_emit(workspace_id);
    }

    /// The current diff stat for one workspace, for the mount snapshot: the
    /// watcher's cached last emit when available, else computed on the spot —
    /// so the snapshot never depends on the watch-seeding thread having run.
    pub fn diff_stat_snapshot(&self, workspace_id: &str, path: &str) -> DiffStat {
        if let Some(e) = self.inner.entries.lock().unwrap().get(workspace_id) {
            if let Some(last) = &e.last {
                return last.diff_stat.clone();
            }
        }
        git::diff_stat(path)
    }
}

fn debounce_loop(inner: Arc<Inner>, rx: Receiver<PathBuf>) {
    let mut dirty: HashSet<String> = HashSet::new();
    loop {
        // Block for the first event.
        match rx.recv() {
            Ok(p) => {
                if let Some(id) = inner.map_path(&p) {
                    dirty.insert(id);
                }
            }
            Err(_) => return, // sender dropped (shutdown)
        }
        // Coalesce everything that arrives within the quiet window.
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(p) => {
                    if let Some(id) = inner.map_path(&p) {
                        dirty.insert(id);
                    }
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        for id in dirty.drain() {
            inner.recompute_and_emit(&id);
        }
    }
}

impl Inner {
    /// Map a changed path to the workspace that owns it (longest-prefix match
    /// over each entry's working tree + git dir), filtering build-output churn.
    fn map_path(&self, p: &Path) -> Option<String> {
        let s = p.to_string_lossy();
        if s.contains("/node_modules/") || s.contains("/target/") {
            return None;
        }
        let entries = self.entries.lock().unwrap();
        let mut best: Option<(usize, String)> = None;
        for (id, e) in entries.iter() {
            for base in [Some(&e.path), e.git_dir.as_ref()].into_iter().flatten() {
                if p.starts_with(base) {
                    let len = base.as_os_str().len();
                    if best.as_ref().is_none_or(|(l, _)| len > *l) {
                        best = Some((len, id.clone()));
                    }
                }
            }
        }
        best.map(|(_, id)| id)
    }

    fn recompute_and_emit(&self, workspace_id: &str) {
        let (path, is_active) = {
            let entries = self.entries.lock().unwrap();
            let Some(e) = entries.get(workspace_id) else {
                return;
            };
            let is_active = self.active.lock().unwrap().as_deref() == Some(workspace_id);
            (e.path.to_string_lossy().to_string(), is_active)
        };

        let diff_stat = git::diff_stat(&path);
        let changes = if is_active { Some(git::changes(&path, "HEAD")) } else { None };
        let branch = git::current_branch(&path).ok();
        let payload = GitPayload { workspace_id: workspace_id.to_string(), diff_stat, changes, branch: branch.clone() };

        // Keep the registry's branch in sync with reality (the agent may
        // rename or switch branches inside the workspace). Merge/push/PR
        // read the registry, so persistence matters beyond the UI.
        if let Some(branch) = branch {
            self.app.state::<crate::project::Registry>().set_workspace_branch(workspace_id, &branch);
        }

        // Dedupe against the last emit; skip if nothing changed.
        let mut entries = self.entries.lock().unwrap();
        if let Some(e) = entries.get_mut(workspace_id) {
            if e.last.as_ref() == Some(&payload) {
                return;
            }
            e.last = Some(payload.clone());
        } else {
            return;
        }
        drop(entries);
        let _ = self.app.emit("workspace:git", &payload);
    }
}
