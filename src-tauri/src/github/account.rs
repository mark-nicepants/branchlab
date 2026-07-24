//! GitHub accounts: the persisted identity model, its JSON store, and the
//! origin-URL parsing + account↔repo matching that auto-binds a project to the
//! right account.
//!
//! Tokens are NEVER stored here (see `github::mod`); an `Account` only holds
//! public identity + the path to this account's isolated `gh` config dir.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Runtime auth health of an account. Persisted best-effort so the UI can show
/// "re-auth needed" immediately on load, before the first API call re-checks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case", tag = "kind", content = "message")]
pub enum AccountStatus {
    /// Authenticated and usable.
    #[default]
    Ok,
    /// Token missing/expired/revoked — the user must sign in again.
    NeedsReauth,
    /// Some other error (network, GHE unreachable). Carries a message.
    Error(String),
}

/// A GitHub identity backing one isolated `gh` auth entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    /// Stable id: `"{host}/{login}"` (e.g. `github.com/octocat`).
    pub id: String,
    /// Host: `github.com` or a GitHub Enterprise host (e.g. `github.acme.com`).
    pub host: String,
    /// API base: `https://api.github.com` (dotcom) or `https://{host}/api/v3` (GHE).
    pub api_base: String,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    /// The account's login + org slugs, lower-cased, for repo-owner matching.
    pub orgs: Vec<String>,
    /// This account's isolated `GH_CONFIG_DIR` (under app_data/github/gh/<slug>).
    pub config_dir: String,
    #[serde(default)]
    pub status: AccountStatus,
}

impl Account {
    /// Build the stable id for a host/login pair.
    pub fn make_id(host: &str, login: &str) -> String {
        format!("{host}/{login}")
    }

    /// Does this account own or belong to `owner` (a repo owner login)?
    fn owns(&self, owner: &str) -> bool {
        let owner = owner.to_ascii_lowercase();
        self.login.eq_ignore_ascii_case(&owner) || self.orgs.iter().any(|o| o.eq_ignore_ascii_case(&owner))
    }
}

/// Map a host to its GitHub API base URL. Dotcom uses `api.github.com`; GitHub
/// Enterprise Server exposes the v3 REST API under `/api/v3` on the same host.
pub fn api_base_for(host: &str) -> String {
    if host.eq_ignore_ascii_case("github.com") {
        "https://api.github.com".to_string()
    } else {
        format!("https://{host}/api/v3")
    }
}

/// A parsed git remote: the GitHub host and the `owner`/`repo` it points at.
#[derive(Debug, Clone, PartialEq)]
pub struct RepoRef {
    pub host: String,
    pub owner: String,
    pub repo: String,
    /// True for SSH remotes (`git@…` / `ssh://…`). The host may be an SSH alias
    /// from `~/.ssh/config` (e.g. `sdb.github.com` → `github.com`), so callers
    /// resolve it before matching accounts.
    pub is_ssh: bool,
}

/// Parse a git `origin` URL into `(host, owner, repo)`. Handles the common
/// forms: `git@host:owner/repo(.git)`, `ssh://git@host[:port]/owner/repo(.git)`,
/// and `https://[user@]host/owner/repo(.git)`. Returns `None` for anything else
/// (local paths, unrecognized schemes).
pub fn parse_remote(url: &str) -> Option<RepoRef> {
    let url = url.trim();
    let (host, path, is_ssh) = if let Some(rest) = url.strip_prefix("git@") {
        // scp-like: git@host:owner/repo.git
        let (host, path) = rest.split_once(':')?;
        (host.to_string(), path.to_string(), true)
    } else if let Some(rest) = url.strip_prefix("ssh://") {
        // ssh://git@host[:port]/owner/repo.git
        let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        let (authority, path) = rest.split_once('/')?;
        let host = authority.split(':').next()?.to_string();
        (host, path.to_string(), true)
    } else {
        let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
        // https://[user@]host/owner/repo.git
        let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        let (authority, path) = rest.split_once('/')?;
        let host = authority.split(':').next()?.to_string();
        (host, path.to_string(), false)
    };

    // path is `owner/repo(.git)`, possibly with a leading slash or extra segments.
    let path = path.trim_start_matches('/').trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut segs = path.split('/').filter(|s| !s.is_empty());
    let owner = segs.next()?.to_string();
    let repo = segs.next()?.to_string();
    if host.is_empty() || owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(RepoRef { host, owner, repo, is_ssh })
}

/// Why account resolution could not pick exactly one account.
#[derive(Debug, Clone, PartialEq)]
pub enum MatchError {
    /// No account is signed in for this host.
    NoAccountForHost(String),
    /// Several accounts could serve this repo; the user must set an override.
    Ambiguous(Vec<String>),
}

/// Pick the account that should serve `repo`, given a candidate set.
///
/// Preference order among accounts on the same host: (1) an account whose
/// login/orgs own the repo owner; (2) if exactly one account exists for the
/// host, use it; otherwise the choice is ambiguous and the caller should ask
/// the user to set a per-project override.
pub fn match_account<'a>(accounts: &'a [Account], repo: &RepoRef) -> Result<&'a Account, MatchError> {
    let same_host: Vec<&Account> = accounts.iter().filter(|a| a.host.eq_ignore_ascii_case(&repo.host)).collect();
    if same_host.is_empty() {
        return Err(MatchError::NoAccountForHost(repo.host.clone()));
    }
    let owners: Vec<&Account> = same_host.iter().copied().filter(|a| a.owns(&repo.owner)).collect();
    match owners.len() {
        1 => return Ok(owners[0]),
        n if n > 1 => return Err(MatchError::Ambiguous(owners.iter().map(|a| a.id.clone()).collect())),
        _ => {}
    }
    if same_host.len() == 1 {
        return Ok(same_host[0]);
    }
    Err(MatchError::Ambiguous(same_host.iter().map(|a| a.id.clone()).collect()))
}

/// Filesystem-safe directory name for an account id (which contains a `/`).
pub fn config_dir_slug(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '-' }).collect()
}

/// Persisted list of accounts (`accounts.json`), guarded by a mutex. Mirrors the
/// shape/discipline of `project::Registry`.
pub struct AccountStore {
    data: Mutex<Vec<Account>>,
    file: PathBuf,
    /// Root under which each account's isolated `gh` config dir lives.
    gh_root: PathBuf,
}

impl AccountStore {
    /// Load from `file`, or start empty. `gh_root` is where per-account
    /// `GH_CONFIG_DIR` directories are created. A present-but-unparseable file is
    /// logged loudly rather than silently discarded (which would drop accounts).
    pub fn load(file: PathBuf, gh_root: PathBuf) -> Self {
        let data = match std::fs::read_to_string(&file) {
            Ok(s) => match serde_json::from_str::<Vec<Account>>(&s) {
                Ok(v) => {
                    crate::logf!("github", "loaded {} account(s) from {}", v.len(), file.display());
                    v
                }
                Err(e) => {
                    crate::logf!("github", "FAILED to parse {}: {e} — starting with no accounts", file.display());
                    Vec::new()
                }
            },
            Err(_) => Vec::new(), // no file yet — first run
        };
        Self { data: Mutex::new(data), file, gh_root }
    }

    fn persist(&self, data: &[Account]) {
        if let Some(parent) = self.file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(data) {
            let _ = std::fs::write(&self.file, json);
        }
    }

    /// The isolated `GH_CONFIG_DIR` path for an account id (created 0700 on add).
    pub fn config_dir_for(&self, id: &str) -> PathBuf {
        self.gh_root.join(config_dir_slug(id))
    }

    pub fn list(&self) -> Vec<Account> {
        self.data.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<Account> {
        self.data.lock().unwrap().iter().find(|a| a.id == id).cloned()
    }

    /// Insert or replace an account by id.
    pub fn upsert(&self, account: Account) {
        let mut data = self.data.lock().unwrap();
        if let Some(existing) = data.iter_mut().find(|a| a.id == account.id) {
            *existing = account;
        } else {
            data.push(account);
        }
        self.persist(&data);
    }

    /// Update just the auth status of an account (e.g. on a 401).
    pub fn set_status(&self, id: &str, status: AccountStatus) {
        let mut data = self.data.lock().unwrap();
        if let Some(a) = data.iter_mut().find(|a| a.id == id) {
            a.status = status;
            self.persist(&data);
        }
    }

    /// Remove an account, returning it (so the caller can clean up its config dir).
    pub fn remove(&self, id: &str) -> Option<Account> {
        let mut data = self.data.lock().unwrap();
        let idx = data.iter().position(|a| a.id == id)?;
        let removed = data.remove(idx);
        self.persist(&data);
        Some(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acct(host: &str, login: &str, orgs: &[&str]) -> Account {
        Account {
            id: Account::make_id(host, login),
            host: host.into(),
            api_base: api_base_for(host),
            login: login.into(),
            name: None,
            avatar_url: None,
            orgs: orgs.iter().map(|s| s.to_string()).collect(),
            config_dir: String::new(),
            status: AccountStatus::Ok,
        }
    }

    #[test]
    fn parses_ssh_scp_form() {
        let r = parse_remote("git@github.com:octocat/hello-world.git").unwrap();
        assert_eq!(
            r,
            RepoRef { host: "github.com".into(), owner: "octocat".into(), repo: "hello-world".into(), is_ssh: true }
        );
    }

    #[test]
    fn parses_https_form_with_and_without_git_suffix() {
        let a = parse_remote("https://github.com/octocat/Hello.git").unwrap();
        let b = parse_remote("https://github.com/octocat/Hello").unwrap();
        assert_eq!(a, b);
        assert_eq!(a.repo, "Hello");
    }

    #[test]
    fn parses_ssh_url_with_port_and_user() {
        let r = parse_remote("ssh://git@github.acme.com:22/team/repo.git").unwrap();
        assert_eq!(
            r,
            RepoRef { host: "github.acme.com".into(), owner: "team".into(), repo: "repo".into(), is_ssh: true }
        );
    }

    #[test]
    fn parses_https_with_embedded_user() {
        let r = parse_remote("https://user@github.com/o/r").unwrap();
        assert_eq!(r.host, "github.com");
        assert_eq!(r.owner, "o");
    }

    #[test]
    fn rejects_non_remotes() {
        assert!(parse_remote("/local/path").is_none());
        assert!(parse_remote("github.com/o/r").is_none());
        assert!(parse_remote("https://github.com/onlyowner").is_none());
    }

    #[test]
    fn api_base_dotcom_vs_ghe() {
        assert_eq!(api_base_for("github.com"), "https://api.github.com");
        assert_eq!(api_base_for("github.acme.com"), "https://github.acme.com/api/v3");
    }

    #[test]
    fn matches_owner_login() {
        let accounts = vec![acct("github.com", "alice", &[]), acct("github.com", "bob", &[])];
        let repo = parse_remote("git@github.com:bob/thing.git").unwrap();
        assert_eq!(match_account(&accounts, &repo).unwrap().login, "bob");
    }

    #[test]
    fn matches_via_org_membership() {
        let accounts = vec![acct("github.com", "alice", &["acme"]), acct("github.com", "bob", &[])];
        let repo = parse_remote("git@github.com:acme/thing.git").unwrap();
        assert_eq!(match_account(&accounts, &repo).unwrap().login, "alice");
    }

    #[test]
    fn single_account_for_host_wins_without_owner_match() {
        let accounts = vec![acct("github.com", "alice", &[])];
        let repo = parse_remote("git@github.com:someorg/thing.git").unwrap();
        assert_eq!(match_account(&accounts, &repo).unwrap().login, "alice");
    }

    #[test]
    fn ambiguous_when_multiple_and_no_owner_match() {
        let accounts = vec![acct("github.com", "alice", &[]), acct("github.com", "bob", &[])];
        let repo = parse_remote("git@github.com:someorg/thing.git").unwrap();
        assert!(matches!(match_account(&accounts, &repo), Err(MatchError::Ambiguous(_))));
    }

    #[test]
    fn no_account_for_host() {
        let accounts = vec![acct("github.com", "alice", &[])];
        let repo = parse_remote("git@github.acme.com:team/repo.git").unwrap();
        assert!(matches!(match_account(&accounts, &repo), Err(MatchError::NoAccountForHost(_))));
    }

    #[test]
    fn store_upsert_get_remove_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("bl-acct-test-{}", std::process::id()));
        let store = AccountStore::load(tmp.join("accounts.json"), tmp.join("gh"));
        store.upsert(acct("github.com", "alice", &[]));
        assert_eq!(store.list().len(), 1);
        store.upsert(acct("github.com", "alice", &["neworg"])); // replace, not duplicate
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.get("github.com/alice").unwrap().orgs, vec!["neworg"]);
        assert!(store.remove("github.com/alice").is_some());
        assert!(store.list().is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
