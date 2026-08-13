//! SetupManager — background workspace provisioning.
//!
//! Workspace creation registers the row instantly (`SetupState::Provisioning`)
//! so the UI can open it with zero delay; this module runs the expensive part
//! off-thread: the `git worktree` checkout, then the project's optional
//! `setup_script`. Progress streams into a persisted System entry in the chat
//! transcript (the "setup card"), and a coarse `workspace:setup` event drives
//! the sidebar spinner. Teardown (`teardown_script`) is the bounded,
//! best-effort mirror image run before workspace removal.
//!
//! Scripts run as `sh -lc` (login shell → user PATH) in the worktree, in their
//! own process group so timeouts kill the whole tree, with
//! `BL_WORKTREE_PATH` / `BL_PROJECT_ROOT` / `BL_WORKSPACE_ID` in the env.
//! (Mechanics distilled from the feat/run-preview branch's run.rs.)

use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::chat::manager::{ChatManager, SetupCard};
use crate::chat::model::{SetupStep, SystemKind, ToolStatus};
use crate::project::{Registry, SetupState};

/// Setup scripts (installs) get plenty of time; teardown stays snappy so
/// deleting a workspace can never hang the UI for long.
const SETUP_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const TEARDOWN_TIMEOUT: Duration = Duration::from_secs(30);
/// Script output lines kept in the persisted card (full stream → debug log).
const LOG_TAIL: usize = 50;
/// Throttle for card re-emits while script output streams.
const CARD_FLUSH: Duration = Duration::from_millis(400);

/// `workspace:setup` — coarse lifecycle for the sidebar (`ok=None` while running).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SetupEvent<'a> {
    workspace_id: &'a str,
    running: bool,
    ok: Option<bool>,
}

#[derive(Clone)]
pub struct SetupManager {
    app: AppHandle,
    /// Workspaces with a pipeline in flight (guards double-starts from Retry).
    active: Arc<Mutex<HashSet<String>>>,
}

impl SetupManager {
    pub fn new(app: AppHandle) -> Self {
        Self { app, active: Arc::new(Mutex::new(HashSet::new())) }
    }

    /// Kick off (or retry) the provisioning pipeline for a workspace.
    /// Non-blocking; no-op if a pipeline is already running or the workspace
    /// has no project (quick chats).
    pub fn start(&self, workspace_id: &str) {
        if !self.active.lock().unwrap().insert(workspace_id.to_string()) {
            return;
        }
        let mgr = self.clone();
        let ws_id = workspace_id.to_string();
        std::thread::spawn(move || {
            mgr.pipeline(&ws_id);
            mgr.active.lock().unwrap().remove(&ws_id);
        });
    }

    fn pipeline(&self, ws_id: &str) {
        let registry = self.app.state::<Registry>();
        let chat = self.app.state::<ChatManager>();
        let Some((ws, settings, root)) = registry.run_context(ws_id) else { return };
        let cwd = Path::new(&ws.path).to_path_buf();
        let script = settings.setup_script.filter(|s| !s.trim().is_empty());

        registry.set_setup_state(ws_id, SetupState::Provisioning);
        self.emit(ws_id, true, None);

        let mut steps = vec![step("Create worktree", ToolStatus::Running)];
        if script.is_some() {
            steps.push(step("Run setup script", ToolStatus::Pending));
        }
        let card = match chat.begin_setup_card(ws_id, &cwd, steps.clone()) {
            Ok(c) => c,
            Err(e) => {
                crate::logf!("setup", "card create failed ws={ws_id}: {e}");
                registry.set_setup_state(ws_id, SetupState::Failed);
                self.emit(ws_id, false, Some(false));
                return;
            }
        };

        // Step 1: worktree checkout (skips instantly if already provisioned).
        if let Err(e) = registry.provision_worktree(ws_id) {
            steps[0].status = ToolStatus::Failed;
            steps[0].log = vec![e.clone()];
            steps[0].ended_at = Some(now_ms());
            self.finish(ws_id, &card, steps, false);
            return;
        }
        steps[0].status = ToolStatus::Completed;
        steps[0].ended_at = Some(now_ms());

        // The worktree exists: watch git state and boot the engine in parallel
        // with the setup script. Prompts stay held until the pipeline ends.
        self.app.state::<crate::watcher::GitWatcher>().watch(ws_id, &ws.path);
        chat.ensure_engine(ws_id, &cwd);

        let ok = match script {
            None => true,
            Some(script) => {
                steps[1].status = ToolStatus::Running;
                steps[1].started_at = Some(now_ms());
                chat.update_setup_card(ws_id, &card, SystemKind::Info, "Setting up workspace".into(), steps.clone());
                let ok = self.run_script(ws_id, &card, &mut steps, &script, &ws.path, &root);
                let i = steps.len() - 1;
                steps[i].status = if ok { ToolStatus::Completed } else { ToolStatus::Failed };
                steps[i].ended_at = Some(now_ms());
                ok
            }
        };
        self.finish(ws_id, &card, steps, ok);
    }

    /// Terminal card + registry state + event + prompt release (on success AND
    /// failure — the workspace stays usable either way; Retry re-runs setup).
    fn finish(&self, ws_id: &str, card: &SetupCard, steps: Vec<SetupStep>, ok: bool) {
        let registry = self.app.state::<Registry>();
        let chat = self.app.state::<ChatManager>();
        registry.set_setup_state(ws_id, if ok { SetupState::Ready } else { SetupState::Failed });
        let secs = (now_ms() - card.created_at) / 1000;
        let (kind, text) = if ok {
            (SystemKind::Success, format!("Workspace set up in {}", fmt_secs(secs)))
        } else {
            (SystemKind::Error, "Workspace setup failed".to_string())
        };
        chat.update_setup_card(ws_id, card, kind, text, steps);
        self.emit(ws_id, false, Some(ok));
        if let Some((ws, _, _)) = registry.run_context(ws_id) {
            chat.release_held(ws_id, Path::new(&ws.path));
        }
    }

    /// Run one script with output streaming into the card's last step.
    /// Returns success. Kills the whole process group on timeout.
    fn run_script(
        &self,
        ws_id: &str,
        card: &SetupCard,
        steps: &mut [SetupStep],
        script: &str,
        cwd: &str,
        project_root: &str,
    ) -> bool {
        let chat = self.app.state::<ChatManager>();
        let i = steps.len() - 1;
        let mut child = match spawn_script(ws_id, script, cwd, project_root) {
            Ok(c) => c,
            Err(e) => {
                steps[i].log.push(e);
                return false;
            }
        };
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        pipe_output(&mut child, tx);

        let deadline = Instant::now() + SETUP_TIMEOUT;
        let mut last_flush = Instant::now();
        loop {
            // Drain pending output into the bounded tail.
            let mut dirty = false;
            while let Ok(line) = rx.try_recv() {
                crate::logf!("setup", "[{ws_id}] {line}");
                steps[i].log.push(line);
                if steps[i].log.len() > LOG_TAIL {
                    let drop = steps[i].log.len() - LOG_TAIL;
                    steps[i].log.drain(..drop);
                }
                dirty = true;
            }
            if dirty && last_flush.elapsed() >= CARD_FLUSH {
                chat.update_setup_card(ws_id, card, SystemKind::Info, "Setting up workspace".into(), steps.to_vec());
                last_flush = Instant::now();
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code().unwrap_or(-1);
                    if code != 0 {
                        steps[i].log.push(format!("exited with {code}"));
                    }
                    return code == 0;
                }
                _ if Instant::now() >= deadline => {
                    kill_group(&child);
                    let _ = child.wait();
                    steps[i].log.push("timed out — killed".into());
                    return false;
                }
                _ => std::thread::sleep(Duration::from_millis(200)),
            }
        }
    }

    /// Best-effort teardown before workspace removal. Blocking, bounded by
    /// [`TEARDOWN_TIMEOUT`]. Returns `None` when no script is configured.
    pub fn run_teardown(&self, workspace_id: &str) -> Option<bool> {
        let registry = self.app.state::<Registry>();
        let (ws, settings, root) = registry.run_context(workspace_id)?;
        let script = settings.teardown_script.filter(|s| !s.trim().is_empty())?;
        if !Path::new(&ws.path).exists() {
            return None;
        }
        crate::logf!("setup", "teardown ws={workspace_id} $ {script}");
        let mut child = match spawn_script(workspace_id, &script, &ws.path, &root) {
            Ok(c) => c,
            Err(e) => {
                crate::logf!("setup", "teardown spawn failed ws={workspace_id}: {e}");
                return Some(false);
            }
        };
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        pipe_output(&mut child, tx);
        let deadline = Instant::now() + TEARDOWN_TIMEOUT;
        loop {
            while let Ok(line) = rx.try_recv() {
                crate::logf!("setup", "[{workspace_id}] {line}");
            }
            match child.try_wait() {
                Ok(Some(status)) => return Some(status.code() == Some(0)),
                _ if Instant::now() >= deadline => {
                    kill_group(&child);
                    let _ = child.wait();
                    crate::logf!("setup", "teardown timed out ws={workspace_id} — killed");
                    return Some(false);
                }
                _ => std::thread::sleep(Duration::from_millis(200)),
            }
        }
    }

    fn emit(&self, workspace_id: &str, running: bool, ok: Option<bool>) {
        let _ = self.app.emit("workspace:setup", SetupEvent { workspace_id, running, ok });
    }
}

fn step(label: &str, status: ToolStatus) -> SetupStep {
    SetupStep { label: label.to_string(), status, log: Vec::new(), started_at: Some(now_ms()), ended_at: None }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn fmt_secs(secs: i64) -> String {
    if secs >= 60 {
        format!("{}m {}s", secs / 60, secs % 60)
    } else {
        format!("{secs}s")
    }
}

/// `sh -lc` in its own process group, worktree cwd, BL_* env.
fn spawn_script(workspace_id: &str, script: &str, cwd: &str, project_root: &str) -> Result<Child, String> {
    let mut cmd = Command::new("sh");
    cmd.arg("-lc")
        .arg(script)
        .current_dir(cwd)
        .env("BL_WORKTREE_PATH", cwd)
        .env("BL_PROJECT_ROOT", project_root)
        .env("BL_WORKSPACE_ID", workspace_id)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().map_err(|e| format!("failed to start script: {e}"))
}

/// Drain stdout+stderr line-wise (ANSI-stripped) into `tx` on two threads so
/// the child's pipes never fill and block it.
fn pipe_output(child: &mut Child, tx: std::sync::mpsc::Sender<String>) {
    for reader in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines().map_while(Result::ok) {
                let clean = strip_ansi(&line);
                if !clean.trim().is_empty() {
                    let _ = tx.send(clean);
                }
            }
        });
    }
}

/// Kill the child's whole process group (scripts spawn their own trees).
fn kill_group(child: &Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("/bin/kill").args(["-KILL", "--", &format!("-{}", child.id())]).output();
    }
    #[cfg(not(unix))]
    {
        let _ = child;
    }
}

/// Strip CSI/OSC escape sequences and carriage returns from a log line.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.peek() {
                // CSI: ESC [ ... final byte @-~
                Some('[') => {
                    chars.next();
                    for c in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC: ESC ] ... BEL (or ESC \)
                Some(']') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\x07' {
                            break;
                        }
                        if c == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                // Single-char escapes (ESC c, ESC 7, …)
                _ => {
                    chars.next();
                }
            },
            '\r' => {}
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_sequences() {
        assert_eq!(strip_ansi("\x1b[32mok\x1b[0m done"), "ok done");
        assert_eq!(strip_ansi("\x1b]0;title\x07text"), "text");
        assert_eq!(strip_ansi("plain\r"), "plain");
    }

    #[test]
    fn formats_durations() {
        assert_eq!(fmt_secs(42), "42s");
        assert_eq!(fmt_secs(90), "1m 30s");
    }
}
