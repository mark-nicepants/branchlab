//! Tauri command surface for the GitHub subsystem. Thin wrappers over
//! `GithubManager`; wrapped again in `src/lib/api.ts`.

use tauri::State;

use crate::github::model::{AccountView, ReviewItem};
use crate::github::GithubManager;

/// List the connected GitHub accounts (public identity only).
#[tauri::command]
pub fn github_list_accounts(github: State<GithubManager>) -> Vec<AccountView> {
    github.accounts_view()
}

/// Re-emit `github:accounts` + `github:review_inbox` so the UI can seed its
/// state on mount — events aren't buffered.
#[tauri::command]
pub fn resync_github(github: State<GithubManager>) {
    github.emit_accounts();
    github.emit_review_inbox();
}

/// The cached review inbox (PRs awaiting your review across all accounts).
#[tauri::command]
pub fn github_review_inbox(github: State<GithubManager>) -> Vec<ReviewItem> {
    github.inbox_items()
}

/// Force a fresh review-inbox poll now (emits `github:review_inbox`).
#[tauri::command]
pub async fn github_refresh_review_inbox(github: State<'_, GithubManager>) -> Result<(), String> {
    github.refresh_inbox().await;
    Ok(())
}

/// Sign an account out and forget it.
#[tauri::command]
pub fn github_remove_account(account_id: String, github: State<GithubManager>) {
    github.remove_account(&account_id);
}

/// Start an interactive `gh auth login --web` device flow. Returns a `loginId`;
/// progress arrives via `github:login` events. `host` defaults to github.com.
#[tauri::command]
pub fn github_start_device_login(host: Option<String>, github: State<GithubManager>) -> String {
    github.start_device_login(host.as_deref().unwrap_or("github.com"))
}

/// Cancel an in-flight device login (kills the `gh` child).
#[tauri::command]
pub fn github_cancel_login(login_id: String, github: State<GithubManager>) {
    github.cancel_login(&login_id);
}

/// Deterministic fallback: add an account from a pasted Personal Access Token
/// (GitHub Enterprise-friendly, or when the browser flow can't run).
#[tauri::command]
pub async fn github_add_account_with_token(
    host: Option<String>,
    token: String,
    github: State<'_, GithubManager>,
) -> Result<AccountView, String> {
    github.add_with_token(host.as_deref().unwrap_or("github.com"), &token).await
}
