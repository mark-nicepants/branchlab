//! ServerManager — owns the lifecycle of `opencode serve` child processes.
//!
//! One OpenCode server is bound to a single working directory (its project is
//! derived from the cwd), so BranchLab runs one server per active workspace.
//! We spawn with `--port 0` (let the OS pick a free port) and parse the
//! "listening on http://host:port" line from stdout to discover the address —
//! more reliable than racing to claim a port ourselves.
//!
//! To stay light on resources for a parallel fleet, a background reaper kills
//! servers that haven't been "touched" by the UI for a while. History lives in
//! opencode's directory-keyed SQLite DB, so a reaped server reconnects cleanly.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

/// How long to wait for the server to announce its listen address.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// Idle window after which an untouched server is reaped.
const IDLE_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// How often the reaper wakes to check for idle servers.
const REAP_INTERVAL: Duration = Duration::from_secs(60);

/// Origins the webview may use, passed to `opencode serve --cors` so the
/// frontend can call the server's REST/SSE endpoints cross-origin.
/// Covers the Vite dev server and the packaged Tauri custom protocol on
/// macOS/Linux and Windows.
pub const CORS_ORIGINS: &[&str] = &["http://localhost:1420", "tauri://localhost", "http://tauri.localhost"];

#[derive(Debug, Clone, Serialize)]
pub struct ServerInfo {
    pub workspace_id: String,
    pub base_url: String,
    pub port: u16,
}

struct RunningServer {
    child: Child,
    info: ServerInfo,
    last_touched: Instant,
}

type ServerMap = Arc<Mutex<HashMap<String, RunningServer>>>;

#[derive(Clone)]
pub struct ServerManager {
    servers: ServerMap,
}

impl Default for ServerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ServerManager {
    pub fn new() -> Self {
        Self { servers: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// Spawn the background idle reaper. Call once at startup.
    pub fn spawn_reaper(&self) {
        let servers = Arc::clone(&self.servers);
        std::thread::spawn(move || loop {
            std::thread::sleep(REAP_INTERVAL);
            let mut map = servers.lock().unwrap();
            let idle: Vec<String> = map
                .iter()
                .filter(|(_, rs)| rs.last_touched.elapsed() > IDLE_TIMEOUT)
                .map(|(id, _)| id.clone())
                .collect();
            for id in idle {
                if let Some(mut rs) = map.remove(&id) {
                    let _ = rs.child.kill();
                    let _ = rs.child.wait();
                }
            }
        });
    }

    /// Start (or return the already-running) server for a workspace.
    pub fn start(&self, workspace_id: &str, cwd: &str) -> Result<ServerInfo, String> {
        let mut servers = self.servers.lock().unwrap();

        // Reuse a live server; reap a dead one before re-spawning.
        if let Some(rs) = servers.get_mut(workspace_id) {
            match rs.child.try_wait() {
                Ok(Some(_)) => {
                    servers.remove(workspace_id);
                }
                _ => {
                    rs.last_touched = Instant::now();
                    return Ok(rs.info.clone());
                }
            }
        }

        let mut cmd = Command::new("opencode");
        cmd.arg("serve").arg("--hostname").arg("127.0.0.1").arg("--port").arg("0");
        for origin in CORS_ORIGINS {
            cmd.arg("--cors").arg(origin);
        }
        cmd.current_dir(cwd).stdout(Stdio::piped()).stderr(Stdio::null());

        let mut child = cmd.spawn().map_err(|e| format!("failed to spawn opencode: {e}"))?;

        let stdout = child.stdout.take().ok_or("opencode produced no stdout")?;
        let (tx, rx) = mpsc::channel::<String>();

        // Drain stdout on a background thread: send the listen URL once, then
        // keep reading so the child's stdout pipe never fills and blocks it.
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut announced = false;
            for line in reader.lines().map_while(Result::ok) {
                if !announced {
                    if let Some(url) = parse_listening_url(&line) {
                        let _ = tx.send(url);
                        announced = true;
                    }
                }
            }
        });

        let base_url = match rx.recv_timeout(READY_TIMEOUT) {
            Ok(url) => url,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("opencode server did not report a listen address in time".into());
            }
        };

        let port = parse_port(&base_url).unwrap_or(0);
        let info = ServerInfo { workspace_id: workspace_id.to_string(), base_url, port };
        servers.insert(
            workspace_id.to_string(),
            RunningServer { child, info: info.clone(), last_touched: Instant::now() },
        );
        Ok(info)
    }

    /// Stop and reap the server for a workspace (no-op if not running).
    pub fn stop(&self, workspace_id: &str) {
        let mut servers = self.servers.lock().unwrap();
        if let Some(mut rs) = servers.remove(workspace_id) {
            let _ = rs.child.kill();
            let _ = rs.child.wait();
        }
    }

    /// Mark a workspace's server as recently used, deferring idle reaping.
    pub fn touch(&self, workspace_id: &str) {
        if let Some(rs) = self.servers.lock().unwrap().get_mut(workspace_id) {
            rs.last_touched = Instant::now();
        }
    }

    /// Current server info, reaping the entry if the process has exited.
    pub fn status(&self, workspace_id: &str) -> Option<ServerInfo> {
        let mut servers = self.servers.lock().unwrap();
        let exited = match servers.get_mut(workspace_id) {
            Some(rs) => matches!(rs.child.try_wait(), Ok(Some(_))),
            None => return None,
        };
        if exited {
            servers.remove(workspace_id);
            return None;
        }
        servers.get(workspace_id).map(|rs| rs.info.clone())
    }

    /// Info for every running server (reaping any that have exited).
    pub fn list(&self) -> Vec<ServerInfo> {
        let mut servers = self.servers.lock().unwrap();
        let mut dead = Vec::new();
        for (id, rs) in servers.iter_mut() {
            if matches!(rs.child.try_wait(), Ok(Some(_))) {
                dead.push(id.clone());
            }
        }
        for id in dead {
            servers.remove(&id);
        }
        servers.values().map(|rs| rs.info.clone()).collect()
    }

    /// Kill every running server — called on app exit.
    pub fn shutdown_all(&self) {
        let mut servers = self.servers.lock().unwrap();
        for (_, mut rs) in servers.drain() {
            let _ = rs.child.kill();
            let _ = rs.child.wait();
        }
    }
}

/// Pull `http://host:port` out of a log line like
/// `opencode server listening on http://127.0.0.1:47391`.
fn parse_listening_url(line: &str) -> Option<String> {
    let idx = line.find("http://")?;
    let url = line[idx..].split_whitespace().next()?.trim_end_matches(['.', ',']);
    Some(url.to_string())
}

fn parse_port(url: &str) -> Option<u16> {
    url.rsplit(':').next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_listen_line() {
        let url = parse_listening_url("opencode server listening on http://127.0.0.1:47391").unwrap();
        assert_eq!(url, "http://127.0.0.1:47391");
        assert_eq!(parse_port(&url), Some(47391));
    }
}
