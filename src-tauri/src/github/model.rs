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
    pub orgs: Vec<String>,
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
            AccountStatus::Error(m) => (false, Some(m.clone())),
        };
        AccountView {
            id: a.id.clone(),
            host: a.host.clone(),
            login: a.login.clone(),
            name: a.name.clone(),
            avatar_url: a.avatar_url.clone(),
            orgs: a.orgs.clone(),
            active,
            status,
        }
    }
}

/// A step in a backend-driven `gh auth login --web` flow, pushed to the
/// AddAccountDialog. One event type covers the whole lifecycle: `awaitingCode`
/// carries `code`+`url`; `success` carries the new `account`; `failed` carries
/// `error`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginEvent {
    pub login_id: String,
    /// "starting" | "awaitingCode" | "polling" | "success" | "failed".
    pub phase: String,
    pub code: Option<String>,
    pub url: Option<String>,
    pub account: Option<AccountView>,
    pub error: Option<String>,
}

impl LoginEvent {
    pub fn phase(login_id: &str, phase: &str) -> Self {
        Self { login_id: login_id.into(), phase: phase.into(), code: None, url: None, account: None, error: None }
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
    /// CI rollup: "success" | "failure" | "pending" | "none".
    pub rollup: String,
    pub is_draft: bool,
    pub updated_at: String,
    /// projectId whose bound repo matches this PR, enabling in-app checkout.
    pub project_id: Option<String>,
}

/// A PR selectable in the "create workspace from PR" picker.
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
