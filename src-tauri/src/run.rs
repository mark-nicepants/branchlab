//! RunManager — runs the project's dev-server script inside a workspace's
//! worktree and streams output + discovered ports to the UI.
//!
//! Sibling of `ServerManager`, but for user-defined run scripts (see
//! docs/design/run-preview.md). Commands run as `sh -lc` (login shell → user
//! PATH) in their own process group so stop kills the whole tree — dev
//! servers fork. Ports are discovered by polling `lsof` and attributing
//! listeners to workspaces via the run child's descendant PID tree (the
//! t3code recipe) rather than stdout parsing: framework-agnostic, and tools
//! that ignore `$BL_PORT` still get found.
//!
//! Events pushed to the UI (see src/lib/events.ts):
//! - `workspace:run`      — a [`RunState`] on every status/port change.
//! - `workspace:run_log`  — one output line at a time.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// lsof/ps poll cadence while at least one run process is alive.
const SCAN_INTERVAL: Duration = Duration::from_secs(3);
/// Grace between SIGTERM and SIGKILL when stopping a run.
const KILL_GRACE: Duration = Duration::from_secs(3);
/// Output lines kept per workspace for the remount snapshot.
const LOG_KEEP: usize = 400;
/// Setup scripts (installs) get plenty of time; teardown stays snappy so
/// workspace removal never hangs on a bad script.
const SETUP_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const TEARDOWN_TIMEOUT: Duration = Duration::from_secs(30);
/// `$BL_PORT` hints are handed out from this range, stepping by 10 so a
/// script that binds BL_PORT+1.. has room (the Conductor port-block contract).
const PORT_HINT_RANGE: std::ops::Range<u16> = 4100..5000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Exited,
}

/// The run state for one workspace, pushed on `workspace:run`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub workspace_id: String,
    pub status: RunStatus,
    /// The free-port hint exported as `$BL_PORT`.
    pub bl_port: u16,
    /// Listening TCP ports attributed to this run's process tree (sorted).
    pub ports: Vec<u16>,
    pub exit_code: Option<i32>,
}

/// Mount-time snapshot: current state (if any run happened) + recent output.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub state: Option<RunState>,
    pub log: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunLogEvent<'a> {
    workspace_id: &'a str,
    chunk: &'a str,
}

struct RunProc {
    child: Child,
    state: RunState,
}

struct Inner {
    app: AppHandle,
    runs: Mutex<HashMap<String, RunProc>>,
    /// Output lines per workspace — kept separate from `runs` so setup /
    /// teardown hooks can log before/after a run process exists.
    logs: Mutex<HashMap<String, VecDeque<String>>>,
    scanner_alive: Mutex<bool>,
}

#[derive(Clone)]
pub struct RunManager {
    inner: Arc<Inner>,
}

impl RunManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            inner: Arc::new(Inner {
                app,
                runs: Mutex::new(HashMap::new()),
                logs: Mutex::new(HashMap::new()),
                scanner_alive: Mutex::new(false),
            }),
        }
    }

    /// Start the run script for a workspace (no-op returning the live state if
    /// already running). Fresh start clears the workspace's log.
    pub fn start(&self, workspace_id: &str, script: &str, cwd: &str, project_root: &str) -> Result<RunState, String> {
        let mut runs = self.inner.runs.lock().unwrap();
        if let Some(rp) = runs.get_mut(workspace_id) {
            if matches!(rp.child.try_wait(), Ok(None)) {
                return Ok(rp.state.clone());
            }
            runs.remove(workspace_id);
        }

        let bl_port = free_port_hint();
        let mut child = spawn_script(script, cwd, project_root, bl_port)?;
        self.inner.logs.lock().unwrap().insert(workspace_id.to_string(), VecDeque::new());
        self.pipe_output(workspace_id, &mut child);
        crate::logf!("run", "start ws={workspace_id} pid={} bl_port={bl_port}", child.id());

        let state = RunState {
            workspace_id: workspace_id.to_string(),
            status: RunStatus::Running,
            bl_port,
            ports: Vec::new(),
            exit_code: None,
        };
        runs.insert(workspace_id.to_string(), RunProc { child, state: state.clone() });
        drop(runs);

        self.append_log(workspace_id, &format!("$ {script}"));
        self.emit_state(&state);
        self.ensure_scanner();
        Ok(state)
    }

    /// Stop a workspace's run: SIGTERM the process group, escalate to SIGKILL
    /// after a grace period. No-op if nothing is running.
    pub fn stop(&self, workspace_id: &str) {
        let mut runs = self.inner.runs.lock().unwrap();
        let Some(mut rp) = runs.remove(workspace_id) else { return };
        drop(runs);

        let pid = rp.child.id();
        kill_group(pid, "TERM");
        let deadline = Instant::now() + KILL_GRACE;
        while Instant::now() < deadline {
            if matches!(rp.child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        kill_group(pid, "KILL");
        let code = rp.child.wait().ok().and_then(|s| s.code());
        crate::logf!("run", "stopped ws={workspace_id} pid={pid}");

        rp.state.status = RunStatus::Exited;
        rp.state.exit_code = code;
        rp.state.ports.clear();
        self.append_log(workspace_id, "stopped");
        self.emit_state(&rp.state);
        // Keep the exited state around for the snapshot.
        self.inner.runs.lock().unwrap().insert(workspace_id.to_string(), rp);
    }

    /// Current state + recent output for a workspace (for view remounts).
    pub fn snapshot(&self, workspace_id: &str) -> RunSnapshot {
        let mut runs = self.inner.runs.lock().unwrap();
        let state = runs.get_mut(workspace_id).map(|rp| {
            // Fold in an exit the scanner hasn't seen yet.
            if rp.state.status == RunStatus::Running {
                if let Ok(Some(st)) = rp.child.try_wait() {
                    rp.state.status = RunStatus::Exited;
                    rp.state.exit_code = st.code();
                    rp.state.ports.clear();
                }
            }
            rp.state.clone()
        });
        let log =
            self.inner.logs.lock().unwrap().get(workspace_id).map(|l| l.iter().cloned().collect()).unwrap_or_default();
        RunSnapshot { state, log }
    }

    /// Run a setup script in a fresh worktree — non-blocking; output streams
    /// into the workspace's run log.
    pub fn run_setup(&self, workspace_id: &str, script: &str, cwd: &str, project_root: &str) {
        let mgr = self.clone();
        let (workspace_id, script, cwd, project_root) =
            (workspace_id.to_string(), script.to_string(), cwd.to_string(), project_root.to_string());
        std::thread::spawn(move || {
            mgr.run_hook(&workspace_id, "setup", &script, &cwd, &project_root, SETUP_TIMEOUT);
        });
    }

    /// Run a teardown script before worktree removal — blocking, best-effort,
    /// bounded by [`TEARDOWN_TIMEOUT`] so removal never hangs.
    pub fn run_teardown(&self, workspace_id: &str, script: &str, cwd: &str, project_root: &str) {
        self.run_hook(workspace_id, "teardown", script, cwd, project_root, TEARDOWN_TIMEOUT);
    }

    /// SIGKILL every run process group — called on app exit.
    pub fn shutdown_all(&self) {
        let mut runs = self.inner.runs.lock().unwrap();
        for (_, mut rp) in runs.drain() {
            if matches!(rp.child.try_wait(), Ok(None)) {
                kill_group(rp.child.id(), "KILL");
                let _ = rp.child.wait();
            }
        }
    }

    // ── internals ──────────────────────────────────────────────────────────

    fn run_hook(
        &self,
        workspace_id: &str,
        label: &str,
        script: &str,
        cwd: &str,
        project_root: &str,
        timeout: Duration,
    ) {
        self.append_log(workspace_id, &format!("[{label}] $ {script}"));
        let mut child = match spawn_script(script, cwd, project_root, 0) {
            Ok(c) => c,
            Err(e) => {
                self.append_log(workspace_id, &format!("[{label}] failed to start: {e}"));
                return;
            }
        };
        self.pipe_output(workspace_id, &mut child);
        let pid = child.id();
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(st)) => {
                    let code = st.code().unwrap_or(-1);
                    self.append_log(workspace_id, &format!("[{label}] exited with {code}"));
                    return;
                }
                _ if Instant::now() >= deadline => {
                    kill_group(pid, "KILL");
                    let _ = child.wait();
                    self.append_log(workspace_id, &format!("[{label}] timed out — killed"));
                    return;
                }
                _ => std::thread::sleep(Duration::from_millis(200)),
            }
        }
    }

    /// Drain the child's stdout+stderr on background threads, appending lines
    /// to the workspace log (also keeps the pipes from filling up).
    fn pipe_output(&self, workspace_id: &str, child: &mut Child) {
        for stream in [child.stdout.take().map(box_read), child.stderr.take().map(box_read)] {
            let Some(stream) = stream else { continue };
            let mgr = self.clone();
            let ws = workspace_id.to_string();
            std::thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    mgr.append_log(&ws, &line);
                }
            });
        }
    }

    fn append_log(&self, workspace_id: &str, line: &str) {
        {
            let mut logs = self.inner.logs.lock().unwrap();
            let buf = logs.entry(workspace_id.to_string()).or_default();
            if buf.len() >= LOG_KEEP {
                buf.pop_front();
            }
            buf.push_back(line.to_string());
        }
        let _ = self.inner.app.emit("workspace:run_log", RunLogEvent { workspace_id, chunk: line });
    }

    fn emit_state(&self, state: &RunState) {
        let _ = self.inner.app.emit("workspace:run", state.clone());
    }

    /// Start the poll loop if it isn't running. It exits when no run process
    /// is alive, so idle BranchLab does zero lsof/ps work.
    fn ensure_scanner(&self) {
        {
            let mut alive = self.inner.scanner_alive.lock().unwrap();
            if *alive {
                return;
            }
            *alive = true;
        }
        let mgr = self.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(SCAN_INTERVAL);
            if !mgr.scan_tick() {
                *mgr.inner.scanner_alive.lock().unwrap() = false;
                return;
            }
        });
    }

    /// One scan pass: reap exits, attribute listening ports to run process
    /// trees, emit changed states. Returns false when nothing is running.
    fn scan_tick(&self) -> bool {
        // Collect exits + live roots without holding the lock across lsof/ps.
        let mut exited: Vec<RunState> = Vec::new();
        let mut roots: Vec<(String, u32)> = Vec::new();
        {
            let mut runs = self.inner.runs.lock().unwrap();
            for (id, rp) in runs.iter_mut() {
                if rp.state.status != RunStatus::Running {
                    continue;
                }
                match rp.child.try_wait() {
                    Ok(Some(st)) => {
                        rp.state.status = RunStatus::Exited;
                        rp.state.exit_code = st.code();
                        rp.state.ports.clear();
                        exited.push(rp.state.clone());
                    }
                    _ => roots.push((id.clone(), rp.child.id())),
                }
            }
        }
        for state in &exited {
            self.append_log(&state.workspace_id, &format!("exited with {}", state.exit_code.unwrap_or(-1)));
            self.emit_state(state);
        }
        if roots.is_empty() {
            return false;
        }

        let tree = ps_pid_ppid();
        let listeners = lsof_listeners();
        let mut changed: Vec<RunState> = Vec::new();
        {
            let mut runs = self.inner.runs.lock().unwrap();
            for (id, root_pid) in roots {
                let family = descendants(root_pid, &tree);
                let mut ports: Vec<u16> =
                    listeners.iter().filter(|(pid, _)| family.contains(pid)).map(|(_, port)| *port).collect();
                ports.sort_unstable();
                ports.dedup();
                if let Some(rp) = runs.get_mut(&id) {
                    if rp.state.ports != ports {
                        rp.state.ports = ports;
                        changed.push(rp.state.clone());
                    }
                }
            }
        }
        for state in &changed {
            self.emit_state(state);
        }
        true
    }
}

/// `sh -lc <script>` in its own process group, cwd = worktree. `bl_port` 0
/// means "no hint" (hooks).
fn spawn_script(script: &str, cwd: &str, project_root: &str, bl_port: u16) -> Result<Child, String> {
    let mut cmd = Command::new("sh");
    cmd.arg("-lc")
        .arg(script)
        .current_dir(cwd)
        .env("BL_WORKTREE_PATH", cwd)
        .env("BL_PROJECT_ROOT", project_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if bl_port > 0 {
        cmd.env("BL_PORT", bl_port.to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // own group → group kill reaps the whole tree
    }
    cmd.spawn().map_err(|e| format!("failed to spawn run script: {e}"))
}

/// Signal a whole process group (pgid == child pid, we set process_group(0)).
fn kill_group(pid: u32, sig: &str) {
    let _ = Command::new("/bin/kill").arg(format!("-{sig}")).arg("--").arg(format!("-{pid}")).status();
}

/// A bindable port from the hint range, stepping by 10 so `$BL_PORT+n` has
/// room. Falls back to an OS-assigned ephemeral port.
fn free_port_hint() -> u16 {
    for port in PORT_HINT_RANGE.step_by(10) {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(0)
}

fn box_read(r: impl std::io::Read + Send + 'static) -> Box<dyn std::io::Read + Send> {
    Box::new(r)
}

/// `(pid, ppid)` pairs for every process (macOS + Linux `ps` syntax).
fn ps_pid_ppid() -> Vec<(u32, u32)> {
    let out = Command::new("ps").args(["-axo", "pid=,ppid="]).output();
    let Ok(out) = out else { return Vec::new() };
    parse_ps(&String::from_utf8_lossy(&out.stdout))
}

/// Locally-listening TCP `(pid, port)` pairs via `lsof -F` machine output.
fn lsof_listeners() -> Vec<(u32, u16)> {
    let out = Command::new("lsof").args(["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"]).output();
    let Ok(out) = out else { return Vec::new() };
    parse_lsof(&String::from_utf8_lossy(&out.stdout))
}

/// Parse `ps -axo pid=,ppid=` output.
fn parse_ps(text: &str) -> Vec<(u32, u32)> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
        })
        .collect()
}

/// Parse `lsof -F pcn` output into `(pid, port)` for loopback/wildcard
/// listeners. Field lines start with a tag char: `p<pid>`, `c<command>`,
/// `n<host>:<port>` (e.g. `n*:5173`, `n127.0.0.1:5173`, `n[::1]:5173`).
fn parse_lsof(text: &str) -> Vec<(u32, u16)> {
    let mut out = Vec::new();
    let mut pid: Option<u32> = None;
    for line in text.lines() {
        match line.split_at_checked(1) {
            Some(("p", rest)) => pid = rest.parse().ok(),
            Some(("n", rest)) => {
                let Some(cur) = pid else { continue };
                let Some((host, port)) = rest.rsplit_once(':') else { continue };
                let local = matches!(host, "*" | "127.0.0.1" | "localhost" | "[::1]" | "[::]");
                if !local {
                    continue;
                }
                if let Ok(port) = port.parse::<u16>() {
                    out.push((cur, port));
                }
            }
            _ => {}
        }
    }
    out
}

/// The root plus all its descendants in a `(pid, ppid)` snapshot.
fn descendants(root: u32, pairs: &[(u32, u32)]) -> HashSet<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, ppid) in pairs {
        children.entry(*ppid).or_default().push(*pid);
    }
    let mut family = HashSet::from([root]);
    let mut queue = vec![root];
    while let Some(p) = queue.pop() {
        for c in children.get(&p).into_iter().flatten() {
            if family.insert(*c) {
                queue.push(*c);
            }
        }
    }
    family
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lsof_extracts_loopback_listeners() {
        let text = "p812\ncnode\nn*:5173\nn127.0.0.1:5174\np900\ncnext-server\nn[::1]:3000\nn192.168.1.5:8080\n";
        let got = parse_lsof(text);
        assert_eq!(got, vec![(812, 5173), (812, 5174), (900, 3000)]);
    }

    #[test]
    fn parse_lsof_ignores_garbage_and_missing_pid() {
        assert!(parse_lsof("n*:5173\nf12\n\n").is_empty());
    }

    #[test]
    fn parse_ps_pairs() {
        let got = parse_ps("  812   100\n 900 812\nnot a line\n");
        assert_eq!(got, vec![(812, 100), (900, 812)]);
    }

    #[test]
    fn descendants_walks_the_tree() {
        // 100 → 812 → 900, 901; 555 unrelated.
        let pairs = vec![(812, 100), (900, 812), (901, 812), (555, 1)];
        let fam = descendants(812, &pairs);
        assert_eq!(fam, HashSet::from([812, 900, 901]));
        assert!(!fam.contains(&555));
    }

    #[test]
    fn free_port_hint_is_bindable() {
        let port = free_port_hint();
        assert!(port > 0);
        // Still free — we only probed it.
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
    }
}
