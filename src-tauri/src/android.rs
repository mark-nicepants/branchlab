//! AndroidManager — one redroid (Android-in-container) instance per
//! flutter-redroid workspace, previewed in-app.
//!
//! This is the local half of the VPS preview stack from
//! docs/design/run-preview.md: container runtime → redroid → adb →
//! `flutter run`. Docker is preferred; Apple's `container` CLI is the
//! fallback (each container is its own lightweight VM there — no
//! `--privileged`, so we grant `--cap-add ALL`; binder availability depends
//! on that VM's kernel, and a missing module surfaces as a boot timeout with
//! a pointer to the container logs).
//!
//! Preview is screencap-poll + `input tap` for now — version-proof and ~zero
//! protocol surface. The scrcpy→WebSocket→WebCodecs stream planned for the
//! VPS phase replaces it wholesale; nothing here depends on the transport.
//!
//! Events pushed to the UI (see src/lib/events.ts):
//! - `workspace:android`       — an [`AndroidState`] on every status change.
//! - `workspace:android_frame` — a PNG data-URL screencap while previewing.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::run::RunManager;

/// AOSP 15, 64-bit only — multi-arch (arm64 on Apple Silicon, x86_64 on
/// Intel/VPS), so Flutter debug builds run natively on both.
/// ponytail: hardcoded image; make it a project setting when someone needs
/// a different Android version.
const REDROID_IMAGE: &str = "docker.io/redroid/redroid:15.0.0_64only-latest";

/// redroid boot arguments: memfd (kernels ≥5.18 ship no ashmem), software GPU
/// (works everywhere), 720p portrait (keeps screencap frames small).
const REDROID_ARGS: &[&str] = &[
    "androidboot.use_memfd=1",
    "androidboot.redroid_gpu_mode=guest",
    "androidboot.redroid_width=720",
    "androidboot.redroid_height=1560",
    "androidboot.redroid_dpi=320",
    "androidboot.redroid_fps=30",
];

/// First boot of a fresh volume takes 30–60s on a warm image; leave slack.
const BOOT_TIMEOUT: Duration = Duration::from_secs(180);
/// Screencap push cadence while a preview panel is watching.
/// ponytail: ~1.4 fps polling; the scrcpy H.264 stream replaces it for real.
const FRAME_INTERVAL: Duration = Duration::from_millis(700);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerRuntime {
    Docker,
    AppleContainer,
}

impl ContainerRuntime {
    fn bin(self) -> &'static str {
        match self {
            ContainerRuntime::Docker => "docker",
            ContainerRuntime::AppleContainer => "container",
        }
    }

    fn label(self) -> &'static str {
        match self {
            ContainerRuntime::Docker => "docker",
            ContainerRuntime::AppleContainer => "apple container",
        }
    }

    /// redroid needs full privileges under docker; Apple `container` has no
    /// `--privileged`, `--cap-add ALL` is the closest equivalent.
    fn privilege_args(self) -> &'static [&'static str] {
        match self {
            ContainerRuntime::Docker => &["--privileged"],
            ContainerRuntime::AppleContainer => &["--cap-add", "ALL"],
        }
    }

    fn pull_args(self) -> &'static [&'static str] {
        match self {
            ContainerRuntime::Docker => &["pull"],
            ContainerRuntime::AppleContainer => &["image", "pull"],
        }
    }
}

/// Docker first (daemon must actually answer), Apple `container` (system
/// service running) as the fallback.
pub fn detect_runtime() -> Result<ContainerRuntime, String> {
    let ok = |bin: &str, args: &[&str]| {
        Command::new(bin)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    if ok("docker", &["info"]) {
        return Ok(ContainerRuntime::Docker);
    }
    if ok("container", &["system", "status"]) {
        return Ok(ContainerRuntime::AppleContainer);
    }
    Err("no container runtime found — start Docker, or Apple's `container system start`".into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AndroidStatus {
    Starting,
    Booting,
    Ready,
    Stopped,
    Error,
}

/// One workspace's Android state, pushed on `workspace:android`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidState {
    pub workspace_id: String,
    pub status: AndroidStatus,
    /// adb serial (`127.0.0.1:<port>`) once connected.
    pub serial: Option<String>,
    /// Human-readable detail for `error` (and progress notes).
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrameEvent<'a> {
    workspace_id: &'a str,
    data_url: &'a str,
}

struct WsAndroid {
    state: AndroidState,
    /// Device screen size (for tap coordinate mapping), probed once ready.
    screen: Option<(u32, u32)>,
    /// Open preview panels; the frame loop runs while > 0.
    viewers: u32,
    frame_loop_alive: bool,
}

struct Inner {
    app: AppHandle,
    runs: RunManager,
    map: Mutex<HashMap<String, WsAndroid>>,
}

#[derive(Clone)]
pub struct AndroidManager {
    inner: Arc<Inner>,
}

impl AndroidManager {
    pub fn new(app: AppHandle, runs: RunManager) -> Self {
        Self { inner: Arc::new(Inner { app, runs, map: Mutex::new(HashMap::new()) }) }
    }

    /// Bring this workspace's redroid container up and return the adb serial.
    /// Blocking (call off the main thread); progress streams into the
    /// workspace run log and `workspace:android` status events.
    pub fn ensure_ready(&self, workspace_id: &str) -> Result<String, String> {
        let name = container_name(workspace_id);
        let port = adb_port_for(workspace_id);
        let serial = format!("127.0.0.1:{port}");

        // Fast path: already connected and booted (container kept warm).
        if self.status_of(workspace_id) == Some(AndroidStatus::Ready) && adb_booted(&serial) {
            return Ok(serial);
        }

        self.set_state(workspace_id, AndroidStatus::Starting, None, None);
        let runtime = match detect_runtime() {
            Ok(rt) => rt,
            Err(e) => {
                self.fail(workspace_id, &e);
                return Err(e);
            }
        };
        self.log(workspace_id, &format!("[android] runtime: {}", runtime.label()));

        // Pull with streamed progress. Failure is non-fatal — a cached image
        // still runs offline; `run` below is the real gate.
        let mut pull: Vec<&str> = runtime.pull_args().to_vec();
        pull.push(REDROID_IMAGE);
        self.stream_cmd(workspace_id, runtime.bin(), &pull);

        // `run` a fresh container; if the name is taken, `start` the existing
        // one. No inspect/schema parsing — the adb boot wait is the real
        // readiness check on both runtimes.
        let mut run_args: Vec<String> =
            vec!["run".into(), "-d".into(), "--name".into(), name.clone(), "-p".into(), format!("{port}:5555")];
        run_args.extend(runtime.privilege_args().iter().map(|s| s.to_string()));
        // Apple `container`'s stock (kata) kernel has no binder; a custom
        // binder-enabled kernel can be supplied via env until upstream ships
        // one (see docs/design/run-preview.md and apple/container#1737).
        if runtime == ContainerRuntime::AppleContainer {
            if let Ok(kernel) = std::env::var("BRANCHLAB_REDROID_KERNEL") {
                if !kernel.trim().is_empty() {
                    run_args.push("--kernel".into());
                    run_args.push(kernel);
                }
            }
        }
        run_args.push(REDROID_IMAGE.into());
        run_args.extend(REDROID_ARGS.iter().map(|s| s.to_string()));
        let run_args: Vec<&str> = run_args.iter().map(|s| s.as_str()).collect();
        if !self.stream_cmd(workspace_id, runtime.bin(), &run_args) {
            self.log(workspace_id, "[android] run failed (name may exist) — trying start");
            self.stream_cmd(workspace_id, runtime.bin(), &["start", &name]);
        }

        // adb connect + boot wait.
        self.set_state(workspace_id, AndroidStatus::Booting, Some(serial.clone()), None);
        self.log(workspace_id, &format!("[android] waiting for boot ({serial})…"));
        let deadline = Instant::now() + BOOT_TIMEOUT;
        loop {
            // Re-issue connect: early attempts get "connection refused" until
            // redroid's adbd is up, and adb drops stale connections.
            let _ = quiet(Command::new("adb").args(["connect", &serial]));
            if adb_booted(&serial) {
                break;
            }
            if Instant::now() >= deadline {
                let msg = format!(
                    "Android did not boot within {}s — likely the container kernel lacks binder \
                     (see `{} logs {name}`). Docker Desktop/Apple container may need a custom kernel.",
                    BOOT_TIMEOUT.as_secs(),
                    runtime.bin(),
                );
                self.fail(workspace_id, &msg);
                return Err(msg);
            }
            std::thread::sleep(Duration::from_secs(2));
        }

        let screen = adb_screen_size(&serial);
        {
            let mut map = self.inner.map.lock().unwrap();
            if let Some(ws) = map.get_mut(workspace_id) {
                ws.screen = screen;
            }
        }
        self.log(workspace_id, "[android] ready");
        self.set_state(workspace_id, AndroidStatus::Ready, Some(serial.clone()), None);
        Ok(serial)
    }

    /// Current state, for view remounts (live updates via `workspace:android`).
    pub fn state(&self, workspace_id: &str) -> Option<AndroidState> {
        self.inner.map.lock().unwrap().get(workspace_id).map(|w| w.state.clone())
    }

    /// Preview refcount from open panels; the screencap loop runs while > 0.
    pub fn set_preview(&self, workspace_id: &str, enabled: bool) {
        let mut map = self.inner.map.lock().unwrap();
        let ws = map.entry(workspace_id.to_string()).or_insert_with(|| blank(workspace_id));
        if enabled {
            ws.viewers += 1;
            if !ws.frame_loop_alive {
                ws.frame_loop_alive = true;
                let mgr = self.clone();
                let id = workspace_id.to_string();
                std::thread::spawn(move || mgr.frame_loop(&id));
            }
        } else {
            ws.viewers = ws.viewers.saturating_sub(1);
        }
    }

    /// Inject a tap at normalized (0..1) coordinates.
    pub fn tap(&self, workspace_id: &str, x: f32, y: f32) -> Result<(), String> {
        let (serial, screen) = {
            let map = self.inner.map.lock().unwrap();
            let ws = map.get(workspace_id).ok_or("no android instance")?;
            if ws.state.status != AndroidStatus::Ready {
                return Err("android not ready".into());
            }
            (ws.state.serial.clone().ok_or("no adb serial")?, ws.screen)
        };
        let (w, h) = screen.unwrap_or((720, 1560));
        let (px, py) = ((x.clamp(0.0, 1.0) * w as f32) as u32, (y.clamp(0.0, 1.0) * h as f32) as u32);
        quiet(Command::new("adb").args(["-s", &serial, "shell", "input", "tap", &px.to_string(), &py.to_string()]))
            .then_some(())
            .ok_or_else(|| "input tap failed".into())
    }

    /// Stop this workspace's container (kept for a warm restart).
    pub fn stop(&self, workspace_id: &str) {
        let Ok(runtime) = detect_runtime() else { return };
        let name = container_name(workspace_id);
        let _ = quiet(Command::new(runtime.bin()).args(["stop", &name]));
        self.set_state(workspace_id, AndroidStatus::Stopped, None, None);
    }

    /// Stop and delete the container — workspace removal.
    pub fn remove(&self, workspace_id: &str) {
        let Ok(runtime) = detect_runtime() else { return };
        let name = container_name(workspace_id);
        let _ = quiet(Command::new(runtime.bin()).args(["stop", &name]));
        let _ = quiet(Command::new(runtime.bin()).args(["rm", &name]));
        self.inner.map.lock().unwrap().remove(workspace_id);
    }

    /// Stop every container we started — app exit. Containers are kept (not
    /// removed) so the next session boots warm.
    pub fn shutdown_all(&self) {
        let ids: Vec<String> = self.inner.map.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.stop(&id);
        }
    }

    // ── internals ──────────────────────────────────────────────────────────

    fn frame_loop(&self, workspace_id: &str) {
        loop {
            std::thread::sleep(FRAME_INTERVAL);
            let serial = {
                let mut map = self.inner.map.lock().unwrap();
                let Some(ws) = map.get_mut(workspace_id) else { return };
                if ws.viewers == 0 {
                    ws.frame_loop_alive = false;
                    return;
                }
                if ws.state.status != AndroidStatus::Ready {
                    continue; // wait for boot; panel is already watching
                }
                match &ws.state.serial {
                    Some(s) => s.clone(),
                    None => continue,
                }
            };
            let Ok(out) = Command::new("adb").args(["-s", &serial, "exec-out", "screencap", "-p"]).output() else {
                continue;
            };
            if !out.status.success() || out.stdout.is_empty() {
                continue;
            }
            let data_url =
                format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&out.stdout));
            let _ = self.inner.app.emit("workspace:android_frame", FrameEvent { workspace_id, data_url: &data_url });
        }
    }

    /// Run a command streaming its stdout+stderr lines into the workspace run
    /// log. Returns success.
    fn stream_cmd(&self, workspace_id: &str, bin: &str, args: &[&str]) -> bool {
        let child =
            Command::new(bin).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                self.log(workspace_id, &format!("[android] {bin} failed to start: {e}"));
                return false;
            }
        };
        let mut readers = Vec::new();
        for stream in [
            child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
            child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        ] {
            let Some(stream) = stream else { continue };
            let mgr = self.clone();
            let id = workspace_id.to_string();
            readers.push(std::thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    mgr.log(&id, &format!("[android] {line}"));
                }
            }));
        }
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        for r in readers {
            let _ = r.join();
        }
        ok
    }

    fn log(&self, workspace_id: &str, line: &str) {
        self.inner.runs.append_log(workspace_id, line);
    }

    fn status_of(&self, workspace_id: &str) -> Option<AndroidStatus> {
        self.inner.map.lock().unwrap().get(workspace_id).map(|w| w.state.status)
    }

    fn fail(&self, workspace_id: &str, msg: &str) {
        self.log(workspace_id, &format!("[android] error: {msg}"));
        self.set_state(workspace_id, AndroidStatus::Error, None, Some(msg.to_string()));
    }

    fn set_state(&self, workspace_id: &str, status: AndroidStatus, serial: Option<String>, message: Option<String>) {
        let state = {
            let mut map = self.inner.map.lock().unwrap();
            let ws = map.entry(workspace_id.to_string()).or_insert_with(|| blank(workspace_id));
            ws.state.status = status;
            ws.state.serial = serial;
            ws.state.message = message;
            ws.state.clone()
        };
        let _ = self.inner.app.emit("workspace:android", state);
    }
}

fn blank(workspace_id: &str) -> WsAndroid {
    WsAndroid {
        state: AndroidState {
            workspace_id: workspace_id.to_string(),
            status: AndroidStatus::Stopped,
            serial: None,
            message: None,
        },
        screen: None,
        viewers: 0,
        frame_loop_alive: false,
    }
}

/// Run a command discarding output; true on success.
fn quiet(cmd: &mut Command) -> bool {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

/// `true` once Android reports boot completed over adb.
fn adb_booted(serial: &str) -> bool {
    Command::new("adb")
        .args(["-s", serial, "shell", "getprop", "sys.boot_completed"])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "1")
        .unwrap_or(false)
}

/// Device screen size via `wm size` ("Physical size: 720x1560").
fn adb_screen_size(serial: &str) -> Option<(u32, u32)> {
    let out = Command::new("adb").args(["-s", serial, "shell", "wm", "size"]).output().ok()?;
    parse_wm_size(&String::from_utf8_lossy(&out.stdout))
}

fn parse_wm_size(text: &str) -> Option<(u32, u32)> {
    let dims = text.lines().find_map(|l| l.rsplit_once(':').map(|(_, d)| d.trim()))?;
    let (w, h) = dims.split_once('x')?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

fn container_name(workspace_id: &str) -> String {
    let safe: String =
        workspace_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    format!("bl-redroid-{safe}")
}

/// Deterministic adb host port per workspace, so a kept container's port
/// mapping matches across sessions without persisting anything.
fn adb_port_for(workspace_id: &str) -> u16 {
    let mut h = DefaultHasher::new();
    workspace_id.hash(&mut h);
    5600 + (h.finish() % 300) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wm_size_parses() {
        assert_eq!(parse_wm_size("Physical size: 720x1560\n"), Some((720, 1560)));
        assert_eq!(parse_wm_size("Physical size: 720x1560\nOverride size: 1080x2340\n"), Some((720, 1560)));
        assert_eq!(parse_wm_size("garbage"), None);
    }

    #[test]
    fn container_name_is_sanitized_and_stable() {
        assert_eq!(container_name("p1-ws1"), "bl-redroid-p1-ws1");
        assert_eq!(container_name("a b/c"), "bl-redroid-a-b-c");
    }

    #[test]
    fn adb_port_is_deterministic_and_in_range() {
        let p = adb_port_for("p1-ws1");
        assert_eq!(p, adb_port_for("p1-ws1"));
        assert!((5600..5900).contains(&p));
    }
}
