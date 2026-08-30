//! Wire DTOs for the GitHub subsystem. Event payloads and command returns are
//! camelCase (`#[serde(rename_all = "camelCase")]`) and mirrored in
//! `src/lib/types.ts`.

use serde::{Deserialize, Serialize};

use crate::github::account::{Account, AccountStatus};

/// An account as the UI sees it — public identity only, never the token.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: String,
    pub host: String,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    /// True when the account is authenticated and usable.
    pub active: bool,
    /// Human-readable status detail when not active (e.g. an error message).
    pub status: Option<String>,
}

impl From<&Account> for AccountView {
    fn from(a: &Account) -> Self {
        let (active, status) = match &a.status {
            AccountStatus::Ok => (true, None),
            AccountStatus::NeedsReauth => (false, Some("Sign-in required".to_string())),
        };
        AccountView {
            id: a.id.clone(),
            host: a.host.clone(),
            login: a.login.clone(),
            name: a.name.clone(),
            avatar_url: a.avatar_url.clone(),
            active,
            status,
        }
    }
}

/// Phases of a backend-driven device-flow login — a real enum so the wire
/// spellings are compiler-checked against the TS `LoginPhase` union.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LoginPhase {
    Starting,
    AwaitingCode,
    Polling,
    Success,
    Failed,
}

/// A step in a backend-driven `gh auth login --web` flow, pushed to the
/// AddAccountDialog. One event type covers the whole lifecycle: `awaitingCode`
/// carries `code`+`url`; `success` carries the new `account`; `failed` carries
/// `error`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginEvent {
    pub login_id: String,
    pub phase: LoginPhase,
    pub code: Option<String>,
    pub url: Option<String>,
    pub account: Option<AccountView>,
    pub error: Option<String>,
}

impl LoginEvent {
    pub fn phase(login_id: &str, phase: LoginPhase) -> Self {
        Self { login_id: login_id.into(), phase, code: None, url: None, account: None, error: None }
    }
}

/// Why a PR is in the review inbox.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewReason {
    ReviewRequested,
    Assigned,
}

/// One PR surfaced in the cross-repo review inbox.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewItem {
    /// Stable id: `"{repo}#{number}"`.
    pub id: String,
    pub account_id: String,
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub author_avatar: Option<String>,
    pub reason: ReviewReason,
    pub head_ref: String,
    /// CI rollup — same enum (and wire spellings) as `PrStatus.rollup`.
    pub rollup: crate::git::Rollup,
    pub is_draft: bool,
    pub updated_at: String,
    /// projectId whose bound repo matches this PR, enabling in-app checkout.
    pub project_id: Option<String>,
}

/// A PR selectable in the "create workspace from PR" picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub number: i64,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub author: String,
    /// RFC3339 — the picker sorts newest-updated first.
    pub updated_at: String,
    /// A "Estimate" number field from any Projects v2 board the issue sits
    /// on — best-effort (needs the `read:project` scope), None otherwise.
    pub estimate: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub author_avatar: Option<String>,
    pub repo: String,
    pub head_ref: String,
    pub base_ref: String,
    pub is_fork: bool,
    pub is_draft: bool,
    pub updated_at: String,
    /// "mine" | "review_requested" | "assigned" — the picker groups by this.
    pub bucket: String,
}
