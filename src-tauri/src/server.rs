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
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::util::LockExt;
use serde::Serialize;

/// How long to wait for the server to announce its listen address.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// Idle window after which an untouched server is reaped.
const IDLE_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// How often the reaper wakes to check for idle servers.
const REAP_INTERVAL: Duration = Duration::from_secs(60);

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

/// One workspace's slot in the server map. `Starting` reserves the slot while
/// the spawn + ready-wait (up to 20s) runs OUTSIDE the map lock, so stop /
/// status / shutdown_all and the reaper are never convoyed behind a boot.
enum Slot {
    Starting,
    Running(RunningServer),
}

/// Map + condvar: waiters on a `Starting` slot park on the condvar and are
/// woken when the boot resolves (either into `Running` or removal on failure).
type ServerMap = Arc<(Mutex<HashMap<String, Slot>>, Condvar)>;

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
        Self { servers: Arc::new((Mutex::new(HashMap::new()), Condvar::new())) }
    }

    /// Spawn the background idle reaper. Call once at startup.
    pub fn spawn_reaper(&self) {
        let servers = Arc::clone(&self.servers);
        std::thread::spawn(move || loop {
            std::thread::sleep(REAP_INTERVAL);
            let mut map = servers.0.lock_safe();
            // Starting slots are skipped — they're seconds old by definition.
            let idle: Vec<String> = map
                .iter()
                .filter(|(_, slot)| matches!(slot, Slot::Running(rs) if rs.last_touched.elapsed() > IDLE_TIMEOUT))
                .map(|(id, _)| id.clone())
                .collect();
            for id in idle {
                if let Some(Slot::Running(mut rs)) = map.remove(&id) {
                    let _ = rs.child.kill();
                    let _ = rs.child.wait();
                }
            }
        });
    }

    /// Start (or return the already-running) server for a workspace. Concurrent
    /// starts for the same workspace coalesce: the first one boots, the rest
    /// wait on its outcome (matching the old whole-map-lock behavior without
    /// blocking unrelated workspaces).
    pub fn start(&self, workspace_id: &str, cwd: &str) -> Result<ServerInfo, String> {
        let (lock, cvar) = &*self.servers;
        {
            let mut map = lock.lock_safe();
            loop {
                match map.get_mut(workspace_id) {
                    // Reuse a live server; reap a dead one before re-spawning.
                    Some(Slot::Running(rs)) => match rs.child.try_wait() {
                        Ok(Some(_)) => {
                            map.remove(workspace_id);
                            break;
                        }
                        _ => {
                            rs.last_touched = Instant::now();
                            return Ok(rs.info.clone());
                        }
                    },
                    // Another start is booting this workspace: wait for its
                    // outcome, then re-check (it may have succeeded or failed).
                    Some(Slot::Starting) => map = cvar.wait(map).unwrap(),
                    None => break,
                }
            }
            // Reserve the slot so no concurrent start races the spawn below.
            map.insert(workspace_id.to_string(), Slot::Starting);
        }

        // The expensive part — spawn + wait for the listen address — runs
        // WITHOUT the lock. The reservation above keeps it exclusive per
        // workspace; every exit path below must resolve the reservation.
        let result = spawn_and_await_ready(workspace_id, cwd);

        let mut map = lock.lock_safe();
        let out = match result {
            Ok((child, info)) => {
                map.insert(
                    workspace_id.to_string(),
                    Slot::Running(RunningServer { child, info: info.clone(), last_touched: Instant::now() }),
                );
                Ok(info)
            }
            Err(e) => {
                map.remove(workspace_id);
                Err(e)
            }
        };
        cvar.notify_all();
        out
    }

    /// Stop and reap the server for a workspace (no-op if not running). Waits
    /// out an in-flight start first, so a booting server can't survive a stop.
    pub fn stop(&self, workspace_id: &str) {
        let (lock, cvar) = &*self.servers;
        let mut map = lock.lock_safe();
        while matches!(map.get(workspace_id), Some(Slot::Starting)) {
            map = cvar.wait(map).unwrap();
        }
        if let Some(Slot::Running(mut rs)) = map.remove(workspace_id) {
            let _ = rs.child.kill();
            let _ = rs.child.wait();
        }
    }

    /// Current server info, reaping the entry if the process has exited. An
    /// in-flight start is awaited (the old behavior: status blocked on the map
    /// lock until the boot finished).
    pub fn status(&self, workspace_id: &str) -> Option<ServerInfo> {
        let (lock, cvar) = &*self.servers;
        let mut map = lock.lock_safe();
        while matches!(map.get(workspace_id), Some(Slot::Starting)) {
            map = cvar.wait(map).unwrap();
        }
        let exited = match map.get_mut(workspace_id) {
            Some(Slot::Running(rs)) => matches!(rs.child.try_wait(), Ok(Some(_))),
            _ => return None,
        };
        if exited {
            map.remove(workspace_id);
            return None;
        }
        match map.get(workspace_id) {
            Some(Slot::Running(rs)) => Some(rs.info.clone()),
            _ => None,
        }
    }

    /// Kill every running server — called on app exit. Waits out in-flight
    /// starts so a server that finishes booting after this can't leak.
    pub fn shutdown_all(&self) {
        let (lock, cvar) = &*self.servers;
        let mut map = lock.lock_safe();
        while map.values().any(|s| matches!(s, Slot::Starting)) {
            map = cvar.wait(map).unwrap();
        }
        for (_, slot) in map.drain() {
            if let Slot::Running(mut rs) = slot {
                let _ = rs.child.kill();
                let _ = rs.child.wait();
            }
        }
    }
}

/// Spawn `opencode serve` in `cwd` and block until it announces its listen
/// address (or times out). Pure spawn/IO — takes no ServerManager locks.
fn spawn_and_await_ready(workspace_id: &str, cwd: &str) -> Result<(Child, ServerInfo), String> {
    let mut cmd = Command::new("opencode");
    cmd.arg("serve").arg("--hostname").arg("127.0.0.1").arg("--port").arg("0");
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
    Ok((child, info))
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

    #[test]
    fn parse_listening_url_ignores_lines_without_http() {
        assert_eq!(parse_listening_url("starting opencode..."), None);
    }

    #[test]
    fn parse_listening_url_trims_trailing_punctuation() {
        let url = parse_listening_url("listening on http://127.0.0.1:1234.").unwrap();
        assert_eq!(url, "http://127.0.0.1:1234");
    }

    #[test]
    fn parse_port_returns_none_when_missing() {
        assert_eq!(parse_port("http://127.0.0.1"), None);
    }
}
