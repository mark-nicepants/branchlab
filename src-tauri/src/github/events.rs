//! Backend → frontend GitHub events (Tauri). Payloads are camelCase and
//! mirrored in `src/lib/types.ts`; the frontend subscribes only through
//! `src/lib/events.ts`.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::github::model::{AccountView, LoginEvent, ReviewItem};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AccountsEvent<'a> {
    accounts: &'a [AccountView],
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReviewInboxEvent<'a> {
    items: &'a [ReviewItem],
    refreshed_at: Option<i64>,
    error: Option<&'a str>,
}

/// The whole account list changed (add/remove/re-auth). The UI replaces its list.
pub fn emit_accounts(app: &AppHandle, accounts: &[AccountView]) {
    let _ = app.emit("github:accounts", AccountsEvent { accounts });
}

/// A device-login lifecycle step (code/url, success, or failure).
pub fn emit_login(app: &AppHandle, event: &LoginEvent) {
    let _ = app.emit("github:login", event);
}

/// A fresh review-inbox snapshot (full replace). Emitted by the inbox poller.
pub fn emit_review_inbox(app: &AppHandle, items: &[ReviewItem], refreshed_at: Option<i64>, error: Option<&str>) {
    let _ = app.emit("github:review_inbox", ReviewInboxEvent { items, refreshed_at, error });
}
