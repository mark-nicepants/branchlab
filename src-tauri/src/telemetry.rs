//! Anonymous usage telemetry via self-hosted Umami (`/api/send`).
//!
//! Privacy contract: no code, paths, branch names, workspace ids, prompts, or
//! anything user-identifying ever leaves the machine — only coarse pageview
//! paths ("/session", "/settings/general") and named events ("session_created")
//! with enum-like properties. Users can opt out in Settings → General; the
//! choice persists as a marker file under app data.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const ENDPOINT: &str = "https://analytics.shady.tools/api/send";
const WEBSITE_ID: &str = "07e73dd7-79fa-4902-8c5a-f920a193a6e4";
/// Virtual hostname the app's traffic files under in Umami.
const HOSTNAME: &str = "app.branchlab.dev";

#[derive(Clone)]
pub struct Telemetry(Arc<Inner>);

struct Inner {
    enabled: AtomicBool,
    /// Existence of this file = user opted out (default is enabled).
    opt_out_marker: PathBuf,
    client: reqwest::Client,
    /// Umami derives OS/device from the User-Agent; a browser-shaped UA with
    /// the app version appended buckets us as macOS and keeps version visible.
    user_agent: String,
}

impl Telemetry {
    pub fn new(app_data_dir: &std::path::Path) -> Self {
        let opt_out_marker = app_data_dir.join("telemetry-opt-out");
        let enabled = !opt_out_marker.exists();
        Telemetry(Arc::new(Inner {
            enabled: AtomicBool::new(enabled),
            opt_out_marker,
            client: reqwest::Client::new(),
            user_agent: format!(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) BranchLab/{}",
                env!("CARGO_PKG_VERSION")
            ),
        }))
    }

    pub fn enabled(&self) -> bool {
        self.0.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, on: bool) {
        self.0.enabled.store(on, Ordering::Relaxed);
        if on {
            let _ = std::fs::remove_file(&self.0.opt_out_marker);
        } else {
            let _ = std::fs::write(&self.0.opt_out_marker, b"");
        }
    }

    /// Track a screen change, website-style ("/home", "/session", …).
    pub fn pageview(&self, url: &str) {
        self.send(json!({
            "website": WEBSITE_ID,
            "hostname": HOSTNAME,
            "language": "en",
            "url": url,
            "title": "BranchLab",
        }));
    }

    /// Track a named event. `data` must stay coarse (enum-like values only).
    pub fn event(&self, name: &str, url: &str, data: Option<Value>) {
        let mut payload = json!({
            "website": WEBSITE_ID,
            "hostname": HOSTNAME,
            "language": "en",
            "url": url,
            "title": "BranchLab",
            "name": name,
        });
        let mut merged = json!({ "version": env!("CARGO_PKG_VERSION") });
        if let Some(Value::Object(extra)) = data {
            for (k, v) in extra {
                merged[k] = v;
            }
        }
        payload["data"] = merged;
        self.send(payload);
    }

    fn send(&self, payload: Value) {
        if !self.enabled() {
            return;
        }
        let inner = self.0.clone();
        // Fire-and-forget: telemetry must never block or fail anything.
        tauri::async_runtime::spawn(async move {
            let res = inner
                .client
                .post(ENDPOINT)
                .header("User-Agent", &inner.user_agent)
                .json(&json!({ "type": "event", "payload": payload }))
                .send()
                .await;
            if let Err(e) = res {
                crate::logx::log("telemetry", &format!("send failed: {e}"));
            }
        });
    }
}

// ── Tauri commands ───────────────────────────────────────────────────────

#[tauri::command]
pub fn telemetry_pageview(telemetry: tauri::State<'_, Telemetry>, url: String) {
    telemetry.pageview(&url);
}

#[tauri::command]
pub fn telemetry_event(telemetry: tauri::State<'_, Telemetry>, name: String, url: String, data: Option<Value>) {
    telemetry.event(&name, &url, data);
}

#[tauri::command]
pub fn telemetry_get_enabled(telemetry: tauri::State<'_, Telemetry>) -> bool {
    telemetry.enabled()
}

#[tauri::command]
pub fn telemetry_set_enabled(telemetry: tauri::State<'_, Telemetry>, enabled: bool) {
    telemetry.set_enabled(enabled);
}
