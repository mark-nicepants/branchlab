//! The orchestration brain.
//!
//! Two responsibilities: (1) translate the chat manager's coarse `TurnEvent`s
//! into per-workspace `workspace:session` / `workspace:notify` state (activity,
//! needs-attention), and (2) run the PR pipeline poll + autofix/superfix loop,
//! sending fix prompts *through the chat manager* (origin=Autofix) so they stream
//! into the same conversation the user sees.
//!
//! There is no second OpenCode connection here anymore — the manager owns the
//! single ACP engine per workspace and broadcasts turn state; the supervisor
//! subscribes. Git/PR state comes from `git`/`gh` (see `poll_pipeline`); todos
//! are emitted by the manager (from ACP plans), not here.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::chat::manager::{ChatManager, TurnEvent};
use crate::chat::model::{TurnOrigin, TurnStatus};
use crate::git::{self, PrStatus};
use crate::github::GithubManager;
use crate::project::{AutofixMode, Registry, WorkspaceKind};

/// Reconcile cadence: PR pipeline poll for driven worktrees.
const TICK: Duration = Duration::from_secs(5);
/// PR status is polled at most this often for driven workspaces (active or
/// autofix-enabled).
const PR_POLL_INTERVAL: Duration = Duration::from_secs(15);
/// Background workspaces (not on screen, autofix off) get a slow safety-net
/// sweep only — freshness comes from event-triggered refreshes (turn end,
/// lifecycle actions, window focus, workspace activation).
const BG_PR_POLL_INTERVAL: Duration = Duration::from_secs(180);
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
pub enum Phase {
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
    // coarse session state (from the manager's TurnEvent broadcast)
    activity: Activity,
    awaiting_input: bool,
    /// Sticky "needs the user" flag: set when a turn finishes or a permission is
    /// asked while this workspace isn't active; cleared when it becomes active.
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
    // emit dedupe
    last_session_emit: Option<SessionPayload>,
    last_pr_emit: Option<PrPayload>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPayload {
    pub workspace_id: String,
    pub activity: String,
    pub awaiting_input: bool,
    pub needs_attention: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrPayload {
    pub workspace_id: String,
    pub status: Option<PrStatus>,
    pub phase: Phase,
    pub attempts: u32,
    pub mode: AutofixMode,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NotifyPayload {
    workspace_id: String,
    kind: &'static str,
}

/// One driven worktree, read synchronously from the registry.
struct DesiredWs {
    id: String,
    path: String,
    /// The parent repo root (where remotes live) — used to resolve the account.
    root: String,
    branch: Option<String>,
    is_worktree: bool,
    mode: AutofixMode,
    /// GitHub account override for the project (`None` = auto-detect).
    account_id: Option<String>,
    /// A fork PR checkout — read-only, so autofix is skipped.
    is_fork: bool,
    /// Not on screen and autofix off: polled on the slow background cadence.
    background: bool,
    /// The PR this workspace was checked out from. When set, PR status is
    /// polled by number — the local `pr-<n>` branch is not the head ref GitHub
    /// knows about, so a by-branch lookup would find nothing.
    pr_number: Option<i64>,
    /// Persisted PR snapshot, to seed the runtime on first sight after restart.
    persisted_pr: Option<PrStatus>,
}

struct Inner {
    app: AppHandle,
    chat: ChatManager,
    github: GithubManager,
    runtimes: Mutex<HashMap<String, WsRuntime>>,
    active: Mutex<Option<String>>,
}

#[derive(Clone)]
pub struct Supervisor {
    inner: Arc<Inner>,
}

impl Supervisor {
    pub fn new(app: AppHandle, chat: ChatManager, github: GithubManager) -> Self {
        Self {
            inner: Arc::new(Inner {
                app,
                chat,
                github,
                runtimes: Mutex::new(HashMap::new()),
                active: Mutex::new(None),
            }),
        }
    }

    /// Spawn the PR reconcile loop and the turn-event consumer. Call once.
    pub fn spawn(&self) {
        let inner = Arc::clone(&self.inner);
        tauri::async_runtime::spawn(async move {
            loop {
                Inner::reconcile(&inner).await;
                tokio::time::sleep(TICK).await;
            }
        });

        // Turn-event consumer: coarse activity + autofix hand-off.
        let inner2 = Arc::clone(&self.inner);
        let mut rx = self.inner.chat.subscribe_turns();
        tauri::async_runtime::spawn(async move {
            while let Ok(ev) = rx.recv().await {
                inner2.on_turn_event(ev);
            }
        });
    }

    /// The workspace currently shown on screen. Clears its needs-attention and
    /// re-pushes snapshots so the just-mounted view gets current state.
    pub fn set_active(&self, workspace_id: Option<String>) {
        *self.inner.active.lock().unwrap() = workspace_id.clone();
        if let Some(id) = &workspace_id {
            if let Some(rt) = self.inner.runtimes.lock().unwrap().get_mut(id) {
                rt.needs_attention = false;
                rt.last_pr_emit = None;
                rt.last_session_emit = None;
            }
            self.inner.emit_pr(id);
            self.inner.emit_session(id);
        }
        self.reconcile_now();
    }

    pub fn reconcile_now(&self) {
        let inner = Arc::clone(&self.inner);
        tauri::async_runtime::spawn(async move {
            Inner::reconcile(&inner).await;
        });
    }

    /// Apply a new autofix mode and re-push the PR snapshot immediately.
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

    /// A complete, race-free read of every workspace's session + PR state for
    /// the frontend's mount snapshot. Uses the live runtime when one exists,
    /// else seeds from the registry's persisted PR — so the sidebar is fully
    /// populated at t=0 without waiting for any poll or event.
    pub fn sidebar_snapshot(&self) -> Vec<WorkspaceStatus> {
        let registry = self.inner.app.state::<Registry>();
        let rts = self.inner.runtimes.lock().unwrap();
        registry
            .all_workspaces()
            .into_iter()
            .map(|w| {
                let rt = rts.get(&w.id);
                let pr_status = rt.map(|r| r.pr.clone()).unwrap_or_else(|| w.pr.clone());
                let phase = match rt {
                    Some(r) => r.phase,
                    // Same seeding as reconcile's first sight of a workspace.
                    None => match pr_status.as_ref().map(|p| p.rollup.as_str()) {
                        Some("success") => Phase::Passing,
                        Some("failure") => Phase::Failing,
                        _ => Phase::Idle,
                    },
                };
                WorkspaceStatus {
                    session: SessionPayload {
                        workspace_id: w.id.clone(),
                        activity: rt.map(|r| r.activity).unwrap_or_default().as_str().to_string(),
                        awaiting_input: rt.is_some_and(|r| r.awaiting_input),
                        needs_attention: rt.is_some_and(|r| r.needs_attention),
                        error: rt.and_then(|r| r.last_error.clone()),
                    },
                    pr: PrPayload {
                        workspace_id: w.id.clone(),
                        status: pr_status,
                        phase,
                        attempts: rt.map(|r| r.super_attempts).unwrap_or(0),
                        mode: rt.map(|r| r.mode).unwrap_or(w.autofix_mode),
                        error: rt.and_then(|r| r.last_error.clone()),
                    },
                }
            })
            .collect()
    }

    /// Schedule an immediate PR re-poll for one workspace (lifecycle actions:
    /// push / merge / PR created — the remote state just changed).
    pub fn poke(&self, workspace_id: &str) {
        if let Some(rt) = self.inner.runtimes.lock().unwrap().get_mut(workspace_id) {
            rt.last_pr_poll = None;
        }
        self.reconcile_now();
    }

    /// Schedule an immediate PR re-poll for every workspace (window focus —
    /// the user is looking, make it fresh).
    pub fn poke_all(&self) {
        for rt in self.inner.runtimes.lock().unwrap().values_mut() {
            rt.last_pr_poll = None;
        }
        self.reconcile_now();
    }
}

/// One workspace's session + PR state, for the mount snapshot.
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceStatus {
    pub session: SessionPayload,
    pub pr: PrPayload,
}

impl Inner {
    /// Every registered workspace. The sidebar shows PR/CI + session state for
    /// all of them, so all are polled — active/autofix-enabled ones on the fast
    /// cadence, the rest in the background.
    fn snapshot_desired(&self) -> Vec<DesiredWs> {
        let registry = self.app.state::<Registry>();
        let active = self.active.lock().unwrap().clone();
        let mut out = Vec::new();
        for w in registry.all_workspaces() {
            let is_active = Some(&w.id) == active.as_ref();
            let enabled = w.autofix_mode != AutofixMode::Off;
            if let Some((ws, root)) = registry.workspace_with_root(&w.id) {
                out.push(DesiredWs {
                    id: ws.id.clone(),
                    path: ws.path.clone(),
                    root,
                    branch: ws.branch.clone(),
                    is_worktree: ws.kind == WorkspaceKind::Worktree,
                    mode: ws.autofix_mode,
                    account_id: registry.project_account_id(&ws.project_id),
                    is_fork: ws.pr_is_fork,
                    background: !is_active && !enabled,
                    pr_number: ws.pr_number,
                    persisted_pr: ws.pr.clone(),
                });
            }
        }
        out
    }

    async fn reconcile(inner: &Arc<Inner>) {
        for d in inner.snapshot_desired() {
            // Seed the runtime from the persisted PR so the UI has state before
            // the first live poll (survives restarts). Release the lock before
            // emitting — emit_pr re-locks `runtimes`.
            let seeded = {
                let mut rts = inner.runtimes.lock().unwrap();
                let fresh = !rts.contains_key(&d.id);
                let rt = rts.entry(d.id.clone()).or_default();
                rt.mode = d.mode;
                if fresh && d.persisted_pr.is_some() {
                    rt.pr = d.persisted_pr.clone();
                    if rt.phase == Phase::Idle {
                        rt.phase = match d.persisted_pr.as_ref().map(|p| p.rollup.as_str()) {
                            Some("success") => Phase::Passing,
                            Some("failure") => Phase::Failing,
                            _ => Phase::Idle,
                        };
                    }
                    true
                } else {
                    false
                }
            };
            if seeded {
                inner.emit_pr(&d.id);
            }
            if d.is_worktree {
                if let Some(branch) = d.branch.clone() {
                    let interval = if d.background { BG_PR_POLL_INTERVAL } else { PR_POLL_INTERVAL };
                    let due = {
                        let rts = inner.runtimes.lock().unwrap();
                        rts.get(&d.id).is_none_or(|rt| rt.last_pr_poll.is_none_or(|t| t.elapsed() >= interval))
                    };
                    if due {
                        inner.poll_pipeline(&d, &branch).await;
                    }
                }
            }
        }
    }

    async fn poll_pipeline(self: &Arc<Inner>, d: &DesiredWs, branch: &str) {
        // PR + CI status comes from the GitHub API (routed through the account
        // bound to this repo). Two lookups:
        //  - PR-checkout workspaces poll BY NUMBER: their local branch is a
        //    synthetic `pr-<n>` name that doesn't exist as a head ref on
        //    GitHub, so a by-branch lookup finds nothing (the `pr: null` bug).
        //  - Regular worktrees poll by the *actual* checked-out branch: the
        //    agent may switch/create a branch inside the worktree (that new
        //    branch is the PR head), so the registry codename can be stale (§F5).
        let (result, what) = match d.pr_number {
            Some(n) => {
                let result = self.github.pr_status_for_number(&d.root, n, d.account_id.as_deref()).await;
                (result, format!("#{n}"))
            }
            None => {
                let cwd = d.path.clone();
                let fallback = branch.to_string();
                let resolved =
                    tauri::async_runtime::spawn_blocking(move || git::current_branch(&cwd).unwrap_or(fallback))
                        .await
                        .unwrap_or_else(|_| branch.to_string());
                let result = self.github.pr_status_for(&d.root, &resolved, d.account_id.as_deref()).await;
                (result, format!("branch={resolved}"))
            }
        };
        let status = match result {
            Ok(opt) => {
                match &opt {
                    Some(pr) => crate::logf!(
                        "pr",
                        "poll ws={} {what} -> PR #{} state={} rollup={}",
                        d.id,
                        pr.number,
                        pr.state,
                        pr.rollup
                    ),
                    None => crate::logf!("pr", "poll ws={} {what} -> no PR", d.id),
                }
                opt
            }
            Err(e) => {
                // Accounts load asynchronously at startup; a resolve failure is
                // transient and local (no API call was made) — retry on the next
                // tick instead of burning the whole poll interval.
                if e.contains("no GitHub account signed in") {
                    crate::logf!("pr", "poll ws={} {what} deferred: {e}", d.id);
                    return;
                }
                crate::logf!("pr", "poll ws={} {what} ERR: {e}", d.id);
                if let Some(rt) = self.runtimes.lock().unwrap().get_mut(&d.id) {
                    rt.last_error = Some(e);
                    rt.last_pr_poll = Some(Instant::now());
                }
                self.emit_pr(&d.id);
                return;
            }
        };

        // Fork PRs are read-only here — never drive autofix back to the fork.
        let mode = if d.is_fork { AutofixMode::Off } else { d.mode };
        let action = {
            let mut rts = self.runtimes.lock().unwrap();
            let Some(rt) = rts.get_mut(&d.id) else {
                return;
            };
            rt.last_pr_poll = Some(Instant::now());
            rt.pr = status.clone();
            rt.last_error = None;
            decide(rt, status.as_ref(), mode)
        };
        // Persist the snapshot so the UI seeds instantly on next launch.
        self.app.state::<Registry>().set_workspace_pr(&d.id, status.clone());
        self.emit_pr(&d.id);

        if let Some(prompt) = action {
            let cwd = PathBuf::from(&d.path);
            let mode_name = if matches!(mode, AutofixMode::Super) { "superfix" } else { "autofix" };
            self.app.state::<crate::telemetry::Telemetry>().event(
                "autofix_run",
                "/session",
                Some(serde_json::json!({ "mode": mode_name })),
            );
            // Route the fix through the chat manager so it streams into the
            // visible conversation; the turn consumer advances the phase when it
            // finishes (origin=Autofix).
            let _ = self.chat.send(
                &d.id,
                &cwd,
                "Fixing CI failures…".to_string(),
                prompt,
                Vec::new(),
                TurnOrigin::Autofix,
                None,
                None,
                None,
            );
        }
    }

    /// Fold a coarse turn transition into session state + autofix progress.
    fn on_turn_event(self: &Arc<Inner>, ev: TurnEvent) {
        let is_active = self.active.lock().unwrap().as_deref() == Some(ev.workspace_id.as_str());
        let mut notify: Option<&'static str> = None;
        let mut pr_changed = false;
        {
            let mut rts = self.runtimes.lock().unwrap();
            let rt = rts.entry(ev.workspace_id.clone()).or_default();
            match ev.status {
                TurnStatus::Queued | TurnStatus::Streaming => {
                    rt.activity = Activity::Working;
                    rt.needs_attention = false;
                    rt.awaiting_input = false;
                }
                TurnStatus::AwaitingPermission => {
                    if !rt.awaiting_input {
                        notify = Some("awaiting_input");
                    }
                    rt.awaiting_input = true;
                    if !is_active {
                        rt.needs_attention = true;
                    }
                }
                TurnStatus::Completed | TurnStatus::Cancelled | TurnStatus::Failed => {
                    if rt.activity == Activity::Working {
                        notify = Some("turn_done");
                        if !is_active {
                            rt.needs_attention = true;
                        }
                    }
                    rt.activity = Activity::Idle;
                    rt.awaiting_input = false;
                    if ev.status == TurnStatus::Failed {
                        rt.last_error = Some("the last turn failed".to_string());
                    }
                    // Autofix hand-off: the fix turn finished.
                    if ev.origin == TurnOrigin::Autofix && rt.phase == Phase::Fixing {
                        rt.phase = if rt.mode == AutofixMode::Super { Phase::Running } else { Phase::AwaitingPush };
                        pr_changed = true;
                    }
                    // Any finished turn may have pushed / opened a PR — re-poll
                    // right away instead of waiting out the interval.
                    rt.last_pr_poll = None;
                }
            }
        }
        self.emit_session(&ev.workspace_id);
        if pr_changed {
            self.emit_pr(&ev.workspace_id);
        }
        if let Some(kind) = notify {
            let _ = self.app.emit("workspace:notify", NotifyPayload { workspace_id: ev.workspace_id.clone(), kind });
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
}

/// Autofix decision — a faithful port of the old `usePrPipeline` state machine.
fn decide(rt: &mut WsRuntime, status: Option<&PrStatus>, mode: AutofixMode) -> Option<String> {
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
            if rt.handled_sha.as_deref() == Some(status.head_sha.as_str()) {
                rt.phase = if mode == AutofixMode::Auto { Phase::AwaitingPush } else { Phase::Running };
                return None;
            }
            if mode == AutofixMode::Super && rt.super_attempts >= MAX_SUPER_ATTEMPTS {
                rt.phase = Phase::Exhausted;
                return None;
            }
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
