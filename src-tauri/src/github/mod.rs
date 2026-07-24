//! The GitHub subsystem — accounts, identity, PR status, and the review inbox.
//!
//! Auth is delegated to `gh` (isolated per account via `GH_CONFIG_DIR`); all
//! data access goes over the GitHub API (`client`). The `GithubManager` is a
//! Tauri-managed singleton holding the account store, per-account API clients,
//! in-memory tokens, and the review-inbox cache. It pushes `github:*` events to
//! the UI (see `events`).
//!
//! Built incrementally; submodules are wired in as they land.

pub mod account;
pub mod auth;
pub mod client;
pub mod commands;
pub mod events;
pub mod login;
pub mod model;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

use crate::github::account::{
    api_base_for, match_account, parse_remote, Account, AccountStatus, AccountStore, MatchError,
};
use crate::github::client::GithubClient;
use crate::github::model::{AccountView, LoginEvent, ReviewItem};
use crate::now_ms;
use crate::project::Registry;
use tauri::Manager;

/// How often the cross-repo review inbox is refreshed (slower than the
/// supervisor's 15s per-workspace PR poll — this is a whole-account search).
const INBOX_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(90);

/// The cross-repo review inbox, cached in memory + mirrored to `inbox.json`.
#[derive(Default)]
struct InboxState {
    items: Vec<ReviewItem>,
    refreshed_at: Option<i64>,
    error: Option<String>,
}

struct GhInner {
    app: AppHandle,
    store: AccountStore,
    /// Root dir for `github/` state (accounts.json, inbox.json, gh/<id> dirs).
    github_dir: PathBuf,
    /// Per-account OAuth tokens, in-memory only (never persisted).
    tokens: Mutex<HashMap<String, String>>,
    /// Per-account API clients, built lazily from cached tokens.
    clients: Mutex<HashMap<String, GithubClient>>,
    /// In-flight device logins → cancel flags (set to abort the `gh` child).
    logins: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Monotonic counter for login ids.
    login_seq: AtomicU64,
    /// Cross-repo review inbox (poller-owned).
    inbox: Mutex<InboxState>,
    /// Cache of SSH host-alias → real host (`ssh -G`), to avoid re-spawning ssh
    /// on every poll. E.g. `sdb.github.com` → `github.com`.
    host_aliases: Mutex<HashMap<String, String>>,
}

/// The GitHub subsystem handle. Cheap to clone (`Arc`), managed as Tauri state.
#[derive(Clone)]
pub struct GithubManager {
    inner: Arc<GhInner>,
}

impl GithubManager {
    /// Load the manager from `github_dir` (created by the caller). Reads
    /// `accounts.json`; API clients/tokens are (re)built lazily.
    pub fn load(app: AppHandle, github_dir: PathBuf) -> Self {
        let store = AccountStore::load(github_dir.join("accounts.json"), github_dir.join("gh"));
        // Seed the inbox from its on-disk cache so the UI has items on first paint.
        let cached: Vec<ReviewItem> = std::fs::read_to_string(github_dir.join("inbox.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            inner: Arc::new(GhInner {
                app,
                store,
                github_dir,
                tokens: Mutex::new(HashMap::new()),
                clients: Mutex::new(HashMap::new()),
                logins: Mutex::new(HashMap::new()),
                login_seq: AtomicU64::new(0),
                inbox: Mutex::new(InboxState { items: cached, refreshed_at: None, error: None }),
                host_aliases: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Start background loops: the cross-repo review-inbox poller (separate,
    /// slower cadence than the supervisor's per-workspace PR poll).
    pub fn spawn(&self) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                this.refresh_inbox().await;
                tokio::time::sleep(INBOX_POLL_INTERVAL).await;
            }
        });
    }

    // ── Account list ──────────────────────────────────────────────────────

    pub fn accounts_view(&self) -> Vec<AccountView> {
        self.inner.store.list().iter().map(AccountView::from).collect()
    }

    /// Re-emit the account list to the UI (events aren't buffered).
    pub fn emit_accounts(&self) {
        events::emit_accounts(&self.inner.app, &self.accounts_view());
    }

    /// Kick a background inbox refresh (after an account is added/removed).
    fn trigger_inbox_refresh(&self) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move { this.refresh_inbox().await });
    }

    /// Remove an account: log it out of its isolated config, delete that config
    /// dir, drop cached token/client, and notify the UI.
    pub fn remove_account(&self, id: &str) {
        if let Some(acct) = self.inner.store.remove(id) {
            auth::logout(Path::new(&acct.config_dir), &acct.host);
            let _ = std::fs::remove_dir_all(&acct.config_dir);
        }
        self.inner.tokens.lock().unwrap().remove(id);
        self.inner.clients.lock().unwrap().remove(id);
        self.emit_accounts();
        self.trigger_inbox_refresh();
    }

    // ── Review inbox ──────────────────────────────────────────────────────

    /// Emit the current inbox snapshot to the UI.
    pub fn emit_review_inbox(&self) {
        let inbox = self.inner.inbox.lock().unwrap();
        events::emit_review_inbox(&self.inner.app, &inbox.items, inbox.refreshed_at, inbox.error.as_deref());
    }

    /// Refresh the cross-repo review inbox across all healthy accounts, cache it
    /// (memory + `inbox.json`), and emit `github:review_inbox`.
    pub async fn refresh_inbox(&self) {
        let accounts = self.inner.store.list();
        let pmap = self.project_repo_map();
        let mut items: Vec<ReviewItem> = Vec::new();
        let mut errors: Vec<String> = Vec::new();

        for acct in &accounts {
            if acct.status != AccountStatus::Ok {
                continue;
            }
            let client = match self.client_for(&acct.id) {
                Ok(c) => c,
                Err(e) => {
                    errors.push(format!("{}: {e}", acct.login));
                    continue;
                }
            };
            match client.review_inbox().await {
                Ok(mut list) => {
                    for it in &mut list {
                        it.account_id = acct.id.clone();
                        it.project_id = pmap.get(&it.repo.to_ascii_lowercase()).cloned();
                    }
                    items.extend(list);
                }
                Err(e) => {
                    if e.contains("401") || e.to_lowercase().contains("bad credentials") {
                        self.inner.tokens.lock().unwrap().remove(&acct.id);
                        self.inner.clients.lock().unwrap().remove(&acct.id);
                        self.inner.store.set_status(&acct.id, AccountStatus::NeedsReauth);
                        self.emit_accounts();
                    }
                    errors.push(format!("{}: {e}", acct.login));
                }
            }
        }
        // Newest first.
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

        {
            let mut inbox = self.inner.inbox.lock().unwrap();
            inbox.items = items;
            inbox.refreshed_at = Some(now_ms());
            inbox.error = if errors.is_empty() { None } else { Some(errors.join("; ")) };
        }
        self.persist_inbox();
        self.emit_review_inbox();
    }

    fn persist_inbox(&self) {
        let items = self.inner.inbox.lock().unwrap().items.clone();
        if let Ok(json) = serde_json::to_string_pretty(&items) {
            let _ = std::fs::write(self.inner.github_dir.join("inbox.json"), json);
        }
    }

    /// Map each project's `origin` repo (`"owner/repo"`, lower-cased) → its
    /// project id, so inbox items in a known repo become checkoutable in-app.
    fn project_repo_map(&self) -> HashMap<String, String> {
        let registry = self.inner.app.state::<Registry>();
        let mut map = HashMap::new();
        for pv in registry.list() {
            if let Ok(remotes) = crate::git::list_remotes(&pv.project.root_path) {
                let origin = remotes.iter().find(|r| r.name == "origin").or_else(|| remotes.first());
                if let Some(repo) = origin.and_then(|r| parse_remote(&r.url)) {
                    map.insert(format!("{}/{}", repo.owner, repo.repo).to_ascii_lowercase(), pv.project.id.clone());
                }
            }
        }
        map
    }

    // ── API client access ─────────────────────────────────────────────────

    /// Get (or lazily build) the API client for an account. Rebuilds the token
    /// from the account's isolated `gh` config if it isn't cached.
    pub fn client_for(&self, account_id: &str) -> Result<GithubClient, String> {
        if let Some(c) = self.inner.clients.lock().unwrap().get(account_id) {
            return Ok(c.clone());
        }
        let acct = self.inner.store.get(account_id).ok_or("unknown account")?;
        let token = self.token_for(&acct)?;
        let client = GithubClient::build(&acct.api_base, &token)?;
        self.inner.clients.lock().unwrap().insert(account_id.to_string(), client.clone());
        Ok(client)
    }

    /// Resolve an SSH host through `~/.ssh/config` (`ssh -G <host>` → its
    /// `hostname`), cached. Returns the input unchanged if ssh fails or there's
    /// no alias. Lets a remote like `git@sdb.github.com:…` match a github.com
    /// account.
    fn resolve_ssh_host(&self, host: &str) -> String {
        if let Some(cached) = self.inner.host_aliases.lock().unwrap().get(host) {
            return cached.clone();
        }
        let resolved = std::process::Command::new("ssh")
            .args(["-G", host])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .find_map(|l| l.strip_prefix("hostname ").map(|h| h.trim().to_string()))
            })
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| host.to_string());
        self.inner.host_aliases.lock().unwrap().insert(host.to_string(), resolved.clone());
        resolved
    }

    fn token_for(&self, acct: &Account) -> Result<String, String> {
        if let Some(t) = self.inner.tokens.lock().unwrap().get(&acct.id) {
            return Ok(t.clone());
        }
        let token = auth::fetch_token(Path::new(&acct.config_dir), &acct.host)?;
        self.inner.tokens.lock().unwrap().insert(acct.id.clone(), token.clone());
        Ok(token)
    }

    /// Resolve which account serves `repo_root` (origin remote), honoring a
    /// per-project override. Returns the account + its parsed `owner`/`repo`.
    pub fn resolve_account(
        &self,
        repo_root: &str,
        override_id: Option<&str>,
    ) -> Result<(Account, String, String), String> {
        let remotes = crate::git::list_remotes(repo_root)?;
        let origin = remotes.iter().find(|r| r.name == "origin").or_else(|| remotes.first());
        let url = origin.ok_or("repo has no git remote")?.url.clone();
        let mut repo = account::parse_remote(&url).ok_or_else(|| format!("origin is not a GitHub remote: {url}"))?;
        // SSH remotes may use a `~/.ssh/config` host alias (e.g. `sdb.github.com`
        // → `github.com`); resolve it so matching sees the real GitHub host.
        if repo.is_ssh {
            repo.host = self.resolve_ssh_host(&repo.host);
        }

        if let Some(id) = override_id {
            let acct = self.inner.store.get(id).ok_or("the project's pinned GitHub account no longer exists")?;
            return Ok((acct, repo.owner, repo.repo));
        }
        let accounts = self.inner.store.list();
        match match_account(&accounts, &repo) {
            Ok(a) => Ok((a.clone(), repo.owner, repo.repo)),
            Err(MatchError::NoAccountForHost(h)) => Err(format!("no GitHub account signed in for {h}")),
            Err(MatchError::Ambiguous(_)) => {
                Err("multiple accounts could serve this repo — pick one in project settings".into())
            }
        }
    }

    /// PR + CI status for a workspace's branch, resolved against the repo's
    /// bound account. `Ok(None)` = no PR; `Err` = no account / API failure.
    /// Only valid when `branch` is the PR's real head ref — PR checkouts use
    /// [`Self::pr_status_for_number`].
    pub async fn pr_status_for(
        &self,
        repo_root: &str,
        branch: &str,
        override_id: Option<&str>,
    ) -> Result<Option<crate::git::PrStatus>, String> {
        let (account, owner, repo) = self.resolve_account(repo_root, override_id)?;
        let client = self.client_for(&account.id)?;
        let result = client.pr_status(&owner, &repo, branch).await;
        self.flag_stale_token(&account.id, &result);
        result
    }

    /// PR + CI status by PR number — for workspaces checked out from a PR
    /// (their local `pr-<n>` branch is not the head ref GitHub knows about).
    pub async fn pr_status_for_number(
        &self,
        repo_root: &str,
        number: i64,
        override_id: Option<&str>,
    ) -> Result<Option<crate::git::PrStatus>, String> {
        let (account, owner, repo) = self.resolve_account(repo_root, override_id)?;
        let client = self.client_for(&account.id)?;
        let result = client.pr_status_by_number(&owner, &repo, number).await;
        self.flag_stale_token(&account.id, &result);
        result
    }

    /// A 401 means the token is stale; flag the account for re-auth.
    fn flag_stale_token<T>(&self, account_id: &str, result: &Result<T, String>) {
        let Err(e) = result else { return };
        if e.contains("401") || e.to_lowercase().contains("bad credentials") {
            self.inner.tokens.lock().unwrap().remove(account_id);
            self.inner.clients.lock().unwrap().remove(account_id);
            self.inner.store.set_status(account_id, AccountStatus::NeedsReauth);
            self.emit_accounts();
        }
    }

    /// Open a PR for a workspace branch via the API (routed through the repo's
    /// bound account). The branch must already be pushed to origin.
    pub async fn create_pr_for(
        &self,
        repo_root: &str,
        head: &str,
        base: &str,
        title: &str,
        body: &str,
        override_id: Option<&str>,
    ) -> Result<String, String> {
        let (account, owner, repo) = self.resolve_account(repo_root, override_id)?;
        let client = self.client_for(&account.id)?;
        client.create_pr(&owner, &repo, head, base, title, body).await
    }

    /// The account auto-detected for a repo from its origin remote (ignoring any
    /// project override) — used to label the override selector. `None` if the
    /// remote doesn't map to a signed-in account.
    pub fn detect_account(&self, repo_root: &str) -> Option<AccountView> {
        match self.resolve_account(repo_root, None) {
            Ok((acct, _, _)) => Some(AccountView::from(&acct)),
            Err(_) => None,
        }
    }

    // ── Adding accounts ───────────────────────────────────────────────────

    fn next_login_id(&self) -> String {
        let n = self.inner.login_seq.fetch_add(1, Ordering::Relaxed);
        let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        format!("login-{ts}-{n}")
    }

    fn ensure_dir_0700(path: &Path) {
        let _ = std::fs::create_dir_all(path);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
        }
    }

    /// Turn a freshly-authenticated isolated config dir into a stored `Account`:
    /// extract the token, fetch identity + orgs over the API, canonicalize the
    /// config dir to the account id, cache token/client, persist, and emit.
    async fn finalize_account(&self, host: &str, temp_dir: &Path) -> Result<AccountView, String> {
        let token = auth::fetch_token(temp_dir, host)?;
        let api_base = api_base_for(host);
        let client = GithubClient::build(&api_base, &token)?;
        let identity = client.current_user().await?;
        let orgs = client.orgs().await;

        let id = Account::make_id(host, &identity.login);
        // Move the config dir to its canonical, id-based location.
        let canonical = self.inner.store.config_dir_for(&id);
        if temp_dir != canonical {
            let _ = std::fs::remove_dir_all(&canonical);
            std::fs::rename(temp_dir, &canonical).map_err(|e| format!("could not finalize config dir: {e}"))?;
        }

        let mut all_orgs = vec![identity.login.to_ascii_lowercase()];
        all_orgs.extend(orgs);
        all_orgs.dedup();

        let account = Account {
            id: id.clone(),
            host: host.to_string(),
            api_base,
            login: identity.login,
            name: identity.name,
            avatar_url: identity.avatar_url,
            orgs: all_orgs,
            config_dir: canonical.to_string_lossy().into_owned(),
            status: AccountStatus::Ok,
        };
        self.inner.tokens.lock().unwrap().insert(id.clone(), token);
        self.inner.clients.lock().unwrap().insert(id.clone(), client);
        self.inner.store.upsert(account.clone());
        self.emit_accounts();
        self.trigger_inbox_refresh();
        Ok(AccountView::from(&account))
    }

    /// Deterministic add path: authenticate an isolated config from a pasted
    /// token (`gh auth login --with-token`), then finalize. GHE-friendly.
    pub async fn add_with_token(&self, host: &str, token: &str) -> Result<AccountView, String> {
        let temp = self.inner.store.config_dir_for(&format!("pending-{}", self.next_login_id()));
        Self::ensure_dir_0700(&temp);
        if let Err(e) = auth::login_with_token(&temp, host, token) {
            let _ = std::fs::remove_dir_all(&temp);
            return Err(e);
        }
        match self.finalize_account(host, &temp).await {
            Ok(v) => Ok(v),
            Err(e) => {
                let _ = std::fs::remove_dir_all(&temp);
                Err(e)
            }
        }
    }

    /// Start an interactive `gh auth login --web` device flow on a background
    /// thread. Returns the `login_id` immediately; progress arrives via
    /// `github:login` events. Cancel with [`cancel_login`].
    pub fn start_device_login(&self, host: &str) -> String {
        let login_id = self.next_login_id();
        let cancel = Arc::new(AtomicBool::new(false));
        self.inner.logins.lock().unwrap().insert(login_id.clone(), cancel.clone());

        let this = self.clone();
        let host = host.to_string();
        let lid = login_id.clone();
        std::thread::spawn(move || {
            this.run_device_login(&host, &lid, cancel);
            this.inner.logins.lock().unwrap().remove(&lid);
        });
        login_id
    }

    /// The current cached inbox items (for the `github_review_inbox` command).
    pub fn inbox_items(&self) -> Vec<ReviewItem> {
        self.inner.inbox.lock().unwrap().items.clone()
    }

    /// Cancel an in-flight device login (kills the `gh` child on the next poll).
    pub fn cancel_login(&self, login_id: &str) {
        if let Some(flag) = self.inner.logins.lock().unwrap().get(login_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    fn run_device_login(&self, host: &str, login_id: &str, cancel: Arc<AtomicBool>) {
        let app = &self.inner.app;
        events::emit_login(app, &LoginEvent::phase(login_id, "starting"));

        let temp = self.inner.store.config_dir_for(&format!("pending-{login_id}"));
        Self::ensure_dir_0700(&temp);

        let mut child = match auth::gh_command(&temp, host)
            .args(["auth", "login", "--hostname", host, "--git-protocol", "https", "--web"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&temp);
                let mut ev = LoginEvent::phase(login_id, "failed");
                ev.error = Some(format!("gh failed to run (is it installed?): {e}"));
                events::emit_login(app, &ev);
                return;
            }
        };

        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let err_buf = Arc::new(Mutex::new(String::new()));

        // The verification URL is host-derived (robust across gh wording).
        let url = format!("https://{host}/login/device");

        // stderr reader: gh prints its prompt here. It owns stdin so it can press
        // Enter (letting gh open the browser) once it has surfaced the one-time
        // code to the UI.
        let h_err = stderr.map(|stderr| {
            let app = app.clone();
            let login_id = login_id.to_string();
            let url = url.clone();
            let err_buf = err_buf.clone();
            let mut stdin = stdin;
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                let mut pressed = false;
                for line in reader.lines().map_while(Result::ok) {
                    {
                        let mut b = err_buf.lock().unwrap();
                        b.push_str(&line);
                        b.push('\n');
                    }
                    if !pressed {
                        if let Some(code) = login::extract_device_code(&line) {
                            let mut ev = LoginEvent::phase(&login_id, "awaitingCode");
                            ev.code = Some(code);
                            ev.url = Some(url.clone());
                            events::emit_login(&app, &ev);
                            if let Some(si) = stdin.as_mut() {
                                let _ = si.write_all(b"\n");
                                let _ = si.flush();
                            }
                            events::emit_login(&app, &LoginEvent::phase(&login_id, "polling"));
                            pressed = true;
                        }
                    }
                }
            })
        });

        // stdout reader: drain it (so gh never blocks on a full pipe) and scan as
        // a fallback in case a gh version prints the code here instead.
        let h_out = stdout.map(|stdout| {
            let app = app.clone();
            let login_id = login_id.to_string();
            let url = url.clone();
            let err_buf = err_buf.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                let mut seen = false;
                for line in reader.lines().map_while(Result::ok) {
                    {
                        let mut b = err_buf.lock().unwrap();
                        b.push_str(&line);
                        b.push('\n');
                    }
                    if !seen {
                        if let Some(code) = login::extract_device_code(&line) {
                            let mut ev = LoginEvent::phase(&login_id, "awaitingCode");
                            ev.code = Some(code);
                            ev.url = Some(url.clone());
                            events::emit_login(&app, &ev);
                            seen = true;
                        }
                    }
                }
            })
        });

        // Poll for completion while honoring cancellation.
        let status = loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_dir_all(&temp);
                // No event on cancel — the dialog has already closed.
                return;
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
                Err(e) => {
                    let _ = std::fs::remove_dir_all(&temp);
                    let mut ev = LoginEvent::phase(login_id, "failed");
                    ev.error = Some(format!("gh did not complete: {e}"));
                    events::emit_login(app, &ev);
                    return;
                }
            }
        };

        let _ = (h_err.map(|h| h.join()), h_out.map(|h| h.join()));

        if !status.success() {
            let _ = std::fs::remove_dir_all(&temp);
            let mut ev = LoginEvent::phase(login_id, "failed");
            let tail = err_buf.lock().unwrap().lines().rev().take(3).collect::<Vec<_>>().join(" ");
            ev.error = Some(if tail.is_empty() { "GitHub sign-in failed".into() } else { tail });
            events::emit_login(app, &ev);
            return;
        }

        match tauri::async_runtime::block_on(self.finalize_account(host, &temp)) {
            Ok(view) => {
                let mut ev = LoginEvent::phase(login_id, "success");
                ev.account = Some(view);
                events::emit_login(app, &ev);
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&temp);
                let mut ev = LoginEvent::phase(login_id, "failed");
                ev.error = Some(e);
                events::emit_login(app, &ev);
            }
        }
    }
}
