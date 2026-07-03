//! The orchestration brain.
//!
//! For every workspace it *drives* (the active one + all autofix-enabled ones)
//! the supervisor keeps an OpenCode server alive, subscribes to its SSE stream
//! for coarse session state (working/idle/awaiting-input/error), polls the PR
//! pipeline, and runs the autofix/superfix loop by sending prompts through the
//! Rust OpenCode client. It pushes state to the UI via `workspace:pr`,
//! `workspace:session`, `workspace:todos`, and `workspace:notify` events. Git
//! state is emitted separately by `watcher.rs`. See AGENTS.md.
//!
//! Runs regardless of what's on screen — this is the whole point of moving the
//! loop out of the frontend. Threading: a single async reconcile loop ticks on
//! the shared runtime; blocking git/gh/server-start calls go through
//! `spawn_blocking`; SSE callbacks do only cheap state updates + emits.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::git::{self, PrStatus};
use crate::opencode::{self, BusEvent, SseHandle, Todo};
use crate::project::{AutofixMode, Registry, WorkspaceKind};
use crate::server::ServerManager;

/// Reconcile cadence: server keep-alive, SSE ensure, todos for the active ws.
const TICK: Duration = Duration::from_secs(5);
/// PR status is polled (via `gh`) at most this often per workspace.
const PR_POLL_INTERVAL: Duration = Duration::from_secs(15);
/// Superfix attempt cap on a single failing streak.
const MAX_SUPER_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Activity {
    #[default]
    Idle,
    Working,
}

impl Activity {
    fn as_str(self) -> &'static str {
        match self {
            Activity::Idle => "idle",
            Activity::Working => "working",
        }
    }
}

/// Pipeline phase — mirrors the old frontend `PipelinePhase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    #[default]
    Idle,
    Running,
    Passing,
    Failing,
    Fixing,
    AwaitingPush,
    Exhausted,
}

#[derive(Default)]
struct WsRuntime {
    // coarse session state (from SSE)
    activity: Activity,
    awaiting_input: bool,
    /// Sticky "needs the user" flag: set when a turn finishes or a question is
    /// asked while this workspace isn't the active one; cleared when it becomes
    /// active or a new turn starts. Drives the sidebar warning icon.
    needs_attention: bool,
    last_error: Option<String>,
    // pipeline
    pr: Option<PrStatus>,
    phase: Phase,
    handled_sha: Option<String>,
    super_attempts: u32,
    last_pr_poll: Option<Instant>,
    // driving
    mode: AutofixMode,
    base_url: Option<String>,
    session_id: Option<String>,
    sse: Option<SseHandle>,
    // emit dedupe
    last_session_emit: Option<SessionPayload>,
    last_pr_emit: Option<PrPayload>,
    last_todos_emit: Option<Vec<Todo>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionPayload {
    workspace_id: String,
    /// "working" while the AI is actively running a turn, else "idle".
    activity: String,
    /// A question is pending (part of `needs_attention`, kept for the chat UI).
    awaiting_input: bool,
    /// The workspace needs the user's attention (question pending, or a turn
    /// finished and hasn't been seen). Authoritative — the sidebar reads this.
    needs_attention: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrPayload {
    workspace_id: String,
    status: Option<PrStatus>,
    phase: Phase,
    attempts: u32,
    mode: AutofixMode,
    error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TodosPayload {
    workspace_id: String,
    todos: Vec<Todo>,
}

/// Everything the reconcile loop needs about one driven workspace, read
/// synchronously from the registry so we never hold a lock across an await.
struct DesiredWs {
    id: String,
    path: String,
    root: String,
    branch: Option<String>,
    is_worktree: bool,
    is_active: bool,
    /// Start the server if needed and keep it warm (active or autofix-enabled).
    /// Observe-only workspaces (a server that's merely running) are watched for
    /// session state but not touched, so the idle reaper can still reclaim them.
    keep_alive: bool,
    mode: AutofixMode,
    registered_session: Option<String>,
}

struct Inner {
    app: AppHandle,
    servers: ServerManager,
    runtimes: Mutex<HashMap<String, WsRuntime>>,
    active: Mutex<Option<String>>,
}

#[derive(Clone)]
pub struct Supervisor {
    inner: Arc<Inner>,
}

impl Supervisor {
    pub fn new(app: AppHandle, servers: ServerManager) -> Self {
        Self { inner: Arc::new(Inner { app, servers, runtimes: Mutex::new(HashMap::new()), active: Mutex::new(None) }) }
    }

    /// Spawn the reconcile loop. Call once at startup (model: ServerManager::spawn_reaper).
    pub fn spawn(&self) {
        let inner = Arc::clone(&self.inner);
        tauri::async_runtime::spawn(async move {
            loop {
                Inner::reconcile(&inner).await;
                tokio::time::sleep(TICK).await;
            }
        });
    }

    /// The workspace currently shown on screen (also gets the `changes` list +
    /// todos). Triggers an immediate reconcile so it starts being driven now.
    pub fn set_active(&self, workspace_id: Option<String>) {
        *self.inner.active.lock().unwrap() = workspace_id.clone();
        // Re-push the current snapshot for the newly active workspace so the UI
        // gets it immediately on switch — dedupe would otherwise suppress an
        // unchanged emit, leaving the just-mounted view waiting for a change.
        if let Some(id) = &workspace_id {
            if let Some(rt) = self.inner.runtimes.lock().unwrap().get_mut(id) {
                // Viewing it clears the "needs you" flag; force a re-emit.
                rt.needs_attention = false;
                rt.last_pr_emit = None;
                rt.last_session_emit = None;
            }
            self.inner.emit_pr(id);
            self.inner.emit_session(id);
        }
        self.reconcile_now();
    }

    /// Re-evaluate the driven set now (after set_autofix_mode / set_active).
    pub fn reconcile_now(&self) {
        let inner = Arc::clone(&self.inner);
        tauri::async_runtime::spawn(async move {
            Inner::reconcile(&inner).await;
        });
    }

    /// Record the session id the frontend created/loaded for a workspace.
    pub fn on_session_registered(&self, workspace_id: &str, session_id: &str) {
        let mut rts = self.inner.runtimes.lock().unwrap();
        let rt = rts.entry(workspace_id.to_string()).or_default();
        rt.session_id = Some(session_id.to_string());
    }

    /// Apply a new autofix mode: update the runtime and re-push the PR snapshot
    /// immediately (so the control reflects it without waiting for a poll),
    /// then reconcile so the driven set updates.
    pub fn note_autofix_mode(&self, workspace_id: &str, mode: AutofixMode) {
        {
            let mut rts = self.inner.runtimes.lock().unwrap();
            let rt = rts.entry(workspace_id.to_string()).or_default();
            rt.mode = mode;
            rt.last_pr_emit = None;
        }
        self.inner.emit_pr(workspace_id);
        self.reconcile_now();
    }

    /// Re-emit current session/pr snapshots, bypassing no-op suppression.
    /// Called on frontend (re)mount to seed fresh listeners.
    pub fn resync(&self) {
        let ids: Vec<String> = self.inner.runtimes.lock().unwrap().keys().cloned().collect();
        for id in &ids {
            if let Some(rt) = self.inner.runtimes.lock().unwrap().get_mut(id) {
                rt.last_session_emit = None;
                rt.last_pr_emit = None;
            }
            self.inner.emit_session(id);
            self.inner.emit_pr(id);
        }
    }
}

impl Inner {
    /// Read the registry synchronously and return the set of workspaces to
    /// observe: the active one, all autofix-enabled ones, and any with a
    /// currently-running server (so a turn started then navigated away from is
    /// still tracked for the sidebar busy indicator). `keep_alive` marks the
    /// ones whose servers we start/warm; the rest are watched as-is.
    fn snapshot_desired(&self) -> Vec<DesiredWs> {
        let registry = self.app.state::<Registry>();
        let active = self.active.lock().unwrap().clone();
        let running: HashSet<String> = self.servers.list().into_iter().map(|s| s.workspace_id).collect();
        let mut out = Vec::new();
        for w in registry.all_workspaces() {
            let is_active = Some(&w.id) == active.as_ref();
            let enabled = w.autofix_mode != AutofixMode::Off;
            let keep_alive = is_active || enabled;
            if !keep_alive && !running.contains(&w.id) {
                continue;
            }
            if let Some((ws, root)) = registry.workspace_with_root(&w.id) {
                out.push(DesiredWs {
                    id: ws.id.clone(),
                    path: ws.path.clone(),
                    root,
                    branch: ws.branch.clone(),
                    is_worktree: ws.kind == WorkspaceKind::Worktree,
                    is_active,
                    keep_alive,
                    mode: ws.autofix_mode,
                    registered_session: ws.session_id.clone(),
                });
            }
        }
        out
    }

    async fn reconcile(inner: &Arc<Inner>) {
        let desired = inner.snapshot_desired();
        let desired_ids: HashSet<String> = desired.iter().map(|d| d.id.clone()).collect();

        // Stop driving workspaces that dropped out of the set: dropping the SSE
        // handle aborts its task, and we stop touching the server so the idle
        // reaper reclaims it.
        {
            let mut rts = inner.runtimes.lock().unwrap();
            for (id, rt) in rts.iter_mut() {
                if !desired_ids.contains(id) {
                    rt.sse = None;
                }
            }
        }

        for d in desired {
            inner.drive_workspace(d).await;
        }
    }

    async fn drive_workspace(self: &Arc<Inner>, d: DesiredWs) {
        // Ensure a runtime entry and refresh its mode / seed its session id.
        {
            let mut rts = self.runtimes.lock().unwrap();
            let rt = rts.entry(d.id.clone()).or_default();
            rt.mode = d.mode;
            if rt.session_id.is_none() {
                rt.session_id = d.registered_session.clone();
            }
        }

        // Keep-alive workspaces get a server started + touched; observe-only
        // ones reuse whatever server is already running (never touched, so the
        // idle reaper can still reclaim them).
        let base_url = if d.keep_alive {
            let Some(b) = self.ensure_server(&d.id, &d.path).await else {
                return;
            };
            self.servers.touch(&d.id);
            b
        } else {
            match self.servers.status(&d.id) {
                Some(info) => info.base_url,
                None => return,
            }
        };

        // Resolve the session id (reuse the chat's when registered; otherwise
        // reuse the newest existing session or create one for background work).
        let session_id = self.ensure_session(&d.id, &base_url).await;

        // Ensure an SSE subscription is running for coarse state.
        {
            let mut rts = self.runtimes.lock().unwrap();
            if let Some(rt) = rts.get_mut(&d.id) {
                rt.base_url = Some(base_url.clone());
                if rt.sse.is_none() {
                    let inner = Arc::clone(self);
                    let wsid = d.id.clone();
                    let sess = rt.session_id.clone();
                    rt.sse = Some(opencode::subscribe_events(&base_url, move |ev| {
                        inner.handle_bus_event(&wsid, sess.as_deref(), ev)
                    }));
                }
            }
        }

        // PR pipeline poll + autofix — only for worktrees we're driving (active
        // or autofix-enabled); observe-only workspaces get session state only.
        if d.is_worktree && d.keep_alive {
            if let Some(branch) = d.branch.clone() {
                let due = {
                    let rts = self.runtimes.lock().unwrap();
                    rts.get(&d.id).is_none_or(|rt| rt.last_pr_poll.is_none_or(|t| t.elapsed() >= PR_POLL_INTERVAL))
                };
                if due {
                    self.poll_pipeline(&d, &branch, &base_url).await;
                }
            }
        }

        // Todos for the active workspace (replaces the frontend 2s poll).
        if d.is_active {
            if let Some(sid) = session_id {
                if let Ok(todos) = opencode::list_todos(&base_url, &sid).await {
                    self.emit_todos(&d.id, todos);
                }
            }
        }
    }

    /// Start (or reuse) a server for the workspace; returns its base URL.
    async fn ensure_server(&self, id: &str, path: &str) -> Option<String> {
        if let Some(info) = self.servers.status(id) {
            return Some(info.base_url);
        }
        let servers = self.servers.clone();
        let (id2, path2) = (id.to_string(), path.to_string());
        match tauri::async_runtime::spawn_blocking(move || servers.start(&id2, &path2)).await {
            Ok(Ok(info)) => Some(info.base_url),
            _ => None,
        }
    }

    /// Resolve the workspace's session id, creating/reusing one if needed.
    async fn ensure_session(&self, id: &str, base_url: &str) -> Option<String> {
        if let Some(s) = self.runtimes.lock().unwrap().get(id).and_then(|rt| rt.session_id.clone()) {
            return Some(s);
        }
        if let Some(s) = self.app.state::<Registry>().session_id(id) {
            if let Some(rt) = self.runtimes.lock().unwrap().get_mut(id) {
                rt.session_id = Some(s.clone());
            }
            return Some(s);
        }
        let existing = opencode::list_sessions(base_url).await.ok().and_then(|list| list.last().map(|s| s.id.clone()));
        let sid = match existing {
            Some(s) => s,
            None => opencode::create_session(base_url).await.ok()?.id,
        };
        self.app.state::<Registry>().set_session_id(id, &sid);
        if let Some(rt) = self.runtimes.lock().unwrap().get_mut(id) {
            rt.session_id = Some(sid.clone());
        }
        Some(sid)
    }

    async fn poll_pipeline(self: &Arc<Inner>, d: &DesiredWs, branch: &str, base_url: &str) {
        let (root, branch2) = (d.root.clone(), branch.to_string());
        let result = tauri::async_runtime::spawn_blocking(move || git::pr_status(&root, &branch2)).await;
        let status = match result {
            Ok(Ok(opt)) => opt,
            Ok(Err(e)) => {
                if let Some(rt) = self.runtimes.lock().unwrap().get_mut(&d.id) {
                    rt.last_error = Some(e);
                    rt.last_pr_poll = Some(Instant::now());
                }
                self.emit_pr(&d.id);
                return;
            }
            Err(_) => return,
        };

        let action = {
            let mut rts = self.runtimes.lock().unwrap();
            let Some(rt) = rts.get_mut(&d.id) else {
                return;
            };
            rt.last_pr_poll = Some(Instant::now());
            rt.pr = status.clone();
            rt.last_error = None;
            decide(rt, status.as_ref(), d.mode)
        };
        self.emit_pr(&d.id);

        if let Some(prompt) = action {
            if let Some(sid) = self.ensure_session(&d.id, base_url).await {
                let _ = opencode::send_prompt(base_url, &sid, &prompt, Some("build")).await;
            }
        }
    }

    /// SSE callback: cheap state update + emit. Never blocks.
    fn handle_bus_event(&self, wsid: &str, session_filter: Option<&str>, ev: BusEvent) {
        // Ignore frames for other sessions on the same server, when we know ours.
        if let (Some(sf), Some(sid)) = (session_filter, ev.properties.get("sessionID").and_then(|v| v.as_str())) {
            if sf != sid {
                return;
            }
        }

        // Whether the user is currently looking at this workspace — we never
        // raise "needs attention" for the workspace on screen.
        let is_active = self.active.lock().unwrap().as_deref() == Some(wsid);

        let mut notify: Option<&'static str> = None;
        let mut pr_changed = false;
        {
            let mut rts = self.runtimes.lock().unwrap();
            let Some(rt) = rts.get_mut(wsid) else {
                return;
            };
            match ev.event_type.as_str() {
                // Streaming content => a turn is actively running. NOTE: only
                // `message.part.updated` marks working, NOT `message.updated` —
                // OpenCode emits a final `message.updated` (token counts) AFTER
                // `session.idle`, which would otherwise flip us back to working
                // and stick the spinner. A new turn also clears prior attention.
                "message.part.updated" => {
                    rt.activity = Activity::Working;
                    rt.needs_attention = false;
                }
                "session.idle" => {
                    if rt.activity == Activity::Working {
                        notify = Some("turn_done");
                        if !is_active {
                            rt.needs_attention = true;
                        }
                    }
                    rt.activity = Activity::Idle;
                    // Advance the autofix loop: the fix turn just finished.
                    if rt.phase == Phase::Fixing {
                        rt.phase = if rt.mode == AutofixMode::Super { Phase::Running } else { Phase::AwaitingPush };
                        rt.last_pr_poll = None; // re-poll on the next tick
                        pr_changed = true;
                    }
                }
                "session.error" => {
                    rt.last_error = ev.properties.get("error").map(|e| e.to_string());
                    rt.activity = Activity::Idle;
                    if !is_active {
                        rt.needs_attention = true;
                    }
                }
                "question.asked" | "question.v2.asked" => {
                    if !rt.awaiting_input {
                        notify = Some("awaiting_input");
                    }
                    rt.awaiting_input = true;
                    if !is_active {
                        rt.needs_attention = true;
                    }
                }
                "question.replied" | "question.v2.replied" | "question.rejected" | "question.v2.rejected" => {
                    rt.awaiting_input = false;
                }
                _ => return,
            }
        }
        self.emit_session(wsid);
        if pr_changed {
            self.emit_pr(wsid);
        }
        if let Some(kind) = notify {
            let _ = self.app.emit("workspace:notify", NotifyPayload { workspace_id: wsid.to_string(), kind });
        }
    }

    fn emit_session(&self, wsid: &str) {
        let payload = {
            let mut rts = self.runtimes.lock().unwrap();
            let Some(rt) = rts.get_mut(wsid) else {
                return;
            };
            let p = SessionPayload {
                workspace_id: wsid.to_string(),
                activity: rt.activity.as_str().to_string(),
                awaiting_input: rt.awaiting_input,
                needs_attention: rt.needs_attention,
                error: rt.last_error.clone(),
            };
            if rt.last_session_emit.as_ref() == Some(&p) {
                return;
            }
            rt.last_session_emit = Some(p.clone());
            p
        };
        let _ = self.app.emit("workspace:session", payload);
    }

    fn emit_pr(&self, wsid: &str) {
        let payload = {
            let mut rts = self.runtimes.lock().unwrap();
            let Some(rt) = rts.get_mut(wsid) else {
                return;
            };
            let p = PrPayload {
                workspace_id: wsid.to_string(),
                status: rt.pr.clone(),
                phase: rt.phase,
                attempts: rt.super_attempts,
                mode: rt.mode,
                error: rt.last_error.clone(),
            };
            if rt.last_pr_emit.as_ref() == Some(&p) {
                return;
            }
            rt.last_pr_emit = Some(p.clone());
            p
        };
        let _ = self.app.emit("workspace:pr", payload);
    }

    fn emit_todos(&self, wsid: &str, todos: Vec<Todo>) {
        {
            let mut rts = self.runtimes.lock().unwrap();
            let Some(rt) = rts.get_mut(wsid) else {
                return;
            };
            if rt.last_todos_emit.as_ref() == Some(&todos) {
                return;
            }
            rt.last_todos_emit = Some(todos.clone());
        }
        let _ = self.app.emit("workspace:todos", TodosPayload { workspace_id: wsid.to_string(), todos });
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NotifyPayload {
    workspace_id: String,
    kind: &'static str,
}

/// Autofix decision — a faithful port of the old `usePrPipeline` state machine.
/// Mutates `rt.phase`/`handled_sha`/`super_attempts` and returns a fix prompt
/// when one should be sent.
fn decide(rt: &mut WsRuntime, status: Option<&PrStatus>, mode: AutofixMode) -> Option<String> {
    // While a fix is in flight, the SSE idle handler advances the phase.
    if rt.phase == Phase::Fixing {
        return None;
    }
    let Some(status) = status else {
        rt.phase = Phase::Idle;
        return None;
    };
    if status.state != "OPEN" || status.rollup == "none" {
        rt.phase = Phase::Idle;
        return None;
    }
    match status.rollup.as_str() {
        "success" => {
            rt.handled_sha = None;
            rt.super_attempts = 0;
            rt.phase = Phase::Passing;
            None
        }
        "pending" => {
            rt.phase = Phase::Running;
            None
        }
        "failure" => {
            if mode == AutofixMode::Off {
                rt.phase = Phase::Failing;
                return None;
            }
            // Already fixed this exact commit — don't loop on the same failure.
            if rt.handled_sha.as_deref() == Some(status.head_sha.as_str()) {
                rt.phase = if mode == AutofixMode::Auto { Phase::AwaitingPush } else { Phase::Running };
                return None;
            }
            if mode == AutofixMode::Super && rt.super_attempts >= MAX_SUPER_ATTEMPTS {
                rt.phase = Phase::Exhausted;
                return None;
            }
            // Don't interrupt an in-flight turn (user chatting, or another action).
            if rt.activity == Activity::Working {
                rt.phase = Phase::Failing;
                return None;
            }
            rt.handled_sha = Some(status.head_sha.clone());
            rt.phase = Phase::Fixing;
            if mode == AutofixMode::Super {
                rt.super_attempts += 1;
            }
            Some(autofix_prompt(status, mode == AutofixMode::Super))
        }
        _ => {
            rt.phase = Phase::Idle;
            None
        }
    }
}

/// Build the fix prompt (ported verbatim from the old frontend `autofixPrompt`).
fn autofix_prompt(status: &PrStatus, push: bool) -> String {
    let failing: Vec<&str> = status.checks.iter().filter(|c| c.bucket == "failure").map(|c| c.name.as_str()).collect();
    let list = if failing.is_empty() { "one or more checks".to_string() } else { failing.join(", ") };
    let base = format!(
        "The CI pipeline for pull request #{} is failing ({}). Investigate and fix it.\n\nSteps:\n1. Inspect the failing checks. Run `gh pr checks` to list them, then read the failing logs — find the run with `gh run list --branch {} --limit 5` and view it with `gh run view <run-id> --log-failed`.\n2. Reproduce the failure locally if you can (run the same lint/test/build command the workflow runs).\n3. Fix the underlying cause in the code. Make the minimal change that makes the check pass.",
        status.number, list, status.head_branch
    );
    if push {
        format!(
            "{base}\n4. Stage the changes with `git add -A`, commit with a clear message describing the fix, and push to the existing branch \"{}\" on origin so the pipeline re-runs. Do NOT open a new pull request.",
            status.head_branch
        )
    } else {
        format!("{base}\n4. Stage the changes with `git add -A` and commit with a clear message describing the fix. Do NOT push — the user will review and push to re-run the pipeline.")
    }
}
