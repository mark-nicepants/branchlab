//! The GitHub API client — one `octocrab` instance per account.
//!
//! Auth is a personal token extracted from the account's isolated `gh` config
//! (see `auth::fetch_token`); the client itself never shells out. GitHub
//! Enterprise is handled by pointing `base_uri` at the account's `api_base`.
//! Every network call is wrapped in a timeout so a hung request can't stall the
//! supervisor's reconcile loop.

use std::sync::Arc;
use std::time::Duration;

use octocrab::Octocrab;
use serde::Deserialize;

use crate::github::model::{PrSummary, ReviewItem, ReviewReason};

/// Hard ceiling on any single API request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Authenticated identity as returned by `GET /user`.
#[derive(Debug, Clone)]
pub struct Identity {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct RawUser {
    login: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct RawOrg {
    login: String,
}

/// A per-account GitHub API client.
#[derive(Clone)]
pub struct GithubClient {
    crab: Arc<Octocrab>,
    host: String,
}

impl GithubClient {
    /// Build a client for one account. `api_base` is `https://api.github.com`
    /// (dotcom) or `https://{host}/api/v3` (GHE); `token` comes from `gh`.
    pub fn build(host: &str, api_base: &str, token: &str) -> Result<Self, String> {
        let crab = Octocrab::builder()
            .base_uri(api_base)
            .map_err(|e| format!("invalid GitHub API base URL: {e}"))?
            .personal_token(token.to_string())
            .build()
            .map_err(|e| format!("could not build GitHub client: {e}"))?;
        Ok(Self { crab: Arc::new(crab), host: host.to_string() })
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    async fn timed<T>(fut: impl std::future::Future<Output = octocrab::Result<T>>) -> Result<T, String> {
        match tokio::time::timeout(REQUEST_TIMEOUT, fut).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(map_err(e)),
            Err(_) => Err("GitHub request timed out".to_string()),
        }
    }

    /// The authenticated user (`GET /user`).
    pub async fn current_user(&self) -> Result<Identity, String> {
        let u: RawUser = Self::timed(self.crab.get("/user", None::<&()>)).await?;
        Ok(Identity { login: u.login, name: u.name, avatar_url: u.avatar_url })
    }

    /// The user's org logins, lower-cased (`GET /user/orgs`), for repo matching.
    /// Best-effort: an error (e.g. missing `read:org` scope) yields an empty list.
    pub async fn orgs(&self) -> Vec<String> {
        match Self::timed(self.crab.get::<Vec<RawOrg>, _, ()>("/user/orgs", None)).await {
            Ok(orgs) => orgs.into_iter().map(|o| o.login.to_ascii_lowercase()).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// PR + CI status for `branch` in `owner/repo`, via one GraphQL query.
    /// Returns the same `git::PrStatus` shape as the legacy `gh` path (reusing
    /// `git::parse_rollup`). `Ok(None)` when the branch has no PR. Only works
    /// when `branch` is the PR's real head ref — for PR-checkout worktrees
    /// (local `pr-<n>` branches) use [`Self::pr_status_by_number`].
    pub async fn pr_status(
        &self,
        owner: &str,
        repo: &str,
        branch: &str,
    ) -> Result<Option<crate::git::PrStatus>, String> {
        let body = serde_json::json!({
            "query": PR_STATUS_QUERY,
            "variables": { "owner": owner, "name": repo, "branch": branch },
        });
        let pr = self.pr_status_node(body, "/repository/pullRequests/nodes/0").await?;
        Ok(pr.as_ref().map(parse_pr_status))
    }

    /// PR + CI status by PR number — the authoritative lookup for workspaces
    /// checked out *from* a PR, whose local branch name (`pr-<n>`) is not the
    /// PR's head ref on GitHub. Also correct for fork PRs, where the head ref
    /// lives in another repo entirely. `Ok(None)` when the PR doesn't exist.
    pub async fn pr_status_by_number(
        &self,
        owner: &str,
        repo: &str,
        number: i64,
    ) -> Result<Option<crate::git::PrStatus>, String> {
        let body = serde_json::json!({
            "query": PR_STATUS_BY_NUMBER_QUERY,
            "variables": { "owner": owner, "name": repo, "number": number },
        });
        let pr = self.pr_status_node(body, "/repository/pullRequest").await?;
        Ok(pr.as_ref().map(parse_pr_status))
    }

    /// Run a PR-status GraphQL query and pluck the PR node at `pointer`.
    /// `Ok(None)` when the node is absent/null (no PR). GitHub reports a
    /// missing PR number as a NOT_FOUND error alongside a null node — treat
    /// that as `None` too, not as a transport failure.
    async fn pr_status_node(
        &self,
        body: serde_json::Value,
        pointer: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        let resp: serde_json::Value = Self::timed(self.crab.graphql(&body)).await?;
        // octocrab may hand back the full envelope or just the data node.
        let root = resp.get("data").unwrap_or(&resp);
        let node = root.pointer(pointer).filter(|v| !v.is_null()).cloned();
        if node.is_none() {
            if let Some(err) = resp.pointer("/errors/0/message").and_then(|m| m.as_str()) {
                let not_found = resp.pointer("/errors/0/type").and_then(|t| t.as_str()) == Some("NOT_FOUND");
                if !not_found {
                    return Err(format!("GitHub GraphQL error: {err}"));
                }
            }
        }
        Ok(node)
    }
}

/// Map a GraphQL PR node (shared shape of both status queries) to `PrStatus`.
fn parse_pr_status(pr: &serde_json::Value) -> crate::git::PrStatus {
    // Flatten each rollup context to the shape git::parse_rollup expects
    // (CheckRun.workflowName lives at a nested path in GraphQL).
    let contexts: Vec<serde_json::Value> = pr
        .pointer("/commits/nodes/0/commit/statusCheckRollup/contexts/nodes")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut c| {
            if let Some(name) =
                c.pointer("/checkSuite/workflowRun/workflow/name").and_then(|x| x.as_str()).map(str::to_string)
            {
                if let Some(obj) = c.as_object_mut() {
                    obj.insert("workflowName".into(), serde_json::Value::String(name));
                }
            }
            c
        })
        .collect();
    let (checks, rollup) = crate::git::parse_rollup(&contexts);

    crate::git::PrStatus {
        number: pr.get("number").and_then(|x| x.as_i64()).unwrap_or(0),
        url: pr.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        state: pr.get("state").and_then(|x| x.as_str()).unwrap_or("OPEN").to_string(),
        head_branch: pr.get("headRefName").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        head_sha: pr.get("headRefOid").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        checks,
        rollup,
    }
}

impl GithubClient {
    /// Open PRs for one repo, bucketed for the "create workspace from PR"
    /// picker: `mine` (authored by you), `review_requested`, `assigned`.
    pub async fn list_open_prs(&self, owner: &str, repo: &str) -> Result<Vec<PrSummary>, String> {
        let base = format!("repo:{owner}/{repo} is:open is:pr");
        let body = serde_json::json!({
            "query": LIST_PRS_QUERY,
            "variables": {
                "mine": format!("{base} author:@me"),
                "review": format!("{base} review-requested:@me"),
                "assigned": format!("{base} assignee:@me"),
            },
        });
        let resp: serde_json::Value = Self::timed(self.crab.graphql(&body)).await?;
        if let Some(err) = resp.pointer("/errors/0/message").and_then(|m| m.as_str()) {
            return Err(format!("GitHub GraphQL error: {err}"));
        }
        let root = resp.get("data").unwrap_or(&resp);
        let mut out: Vec<PrSummary> = Vec::new();
        let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();
        for (alias, bucket) in [("mine", "mine"), ("review", "review_requested"), ("assigned", "assigned")] {
            let nodes =
                root.pointer(&format!("/{alias}/nodes")).and_then(|n| n.as_array()).cloned().unwrap_or_default();
            for n in nodes {
                if let Some(s) = parse_pr_summary(&n, bucket) {
                    if seen.insert(s.number) {
                        out.push(s);
                    }
                }
            }
        }
        Ok(out)
    }

    /// Open a pull request and return its URL. The head branch must already be
    /// pushed to `origin`.
    pub async fn create_pr(
        &self,
        owner: &str,
        repo: &str,
        head: &str,
        base: &str,
        title: &str,
        body: &str,
    ) -> Result<String, String> {
        let pr = Self::timed(self.crab.pulls(owner, repo).create(title, head, base).body(body).send()).await?;
        Ok(pr.html_url.map(|u| u.to_string()).unwrap_or_default())
    }

    /// Full detail for one PR (head/base refs, fork flag) — used when checking a
    /// PR out into a worktree.
    pub async fn pr_detail(&self, owner: &str, repo: &str, number: i64) -> Result<PrSummary, String> {
        let body = serde_json::json!({
            "query": PR_DETAIL_QUERY,
            "variables": { "owner": owner, "name": repo, "number": number },
        });
        let resp: serde_json::Value = Self::timed(self.crab.graphql(&body)).await?;
        if let Some(err) = resp.pointer("/errors/0/message").and_then(|m| m.as_str()) {
            return Err(format!("GitHub GraphQL error: {err}"));
        }
        let root = resp.get("data").unwrap_or(&resp);
        let node = root.pointer("/repository/pullRequest").ok_or("pull request not found")?;
        parse_pr_summary(node, "mine").ok_or_else(|| "could not parse pull request".to_string())
    }

    /// Cross-repo review inbox for the authenticated user: open PRs where they
    /// are requested as a reviewer or assigned. One GraphQL request (two aliased
    /// searches). `account_id`/`project_id` are filled in by the caller.
    pub async fn review_inbox(&self) -> Result<Vec<ReviewItem>, String> {
        let body = serde_json::json!({ "query": REVIEW_INBOX_QUERY });
        let resp: serde_json::Value = Self::timed(self.crab.graphql(&body)).await?;
        if let Some(err) = resp.pointer("/errors/0/message").and_then(|m| m.as_str()) {
            return Err(format!("GitHub GraphQL error: {err}"));
        }
        let root = resp.get("data").unwrap_or(&resp);

        let mut out: Vec<ReviewItem> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        // review-requested takes precedence over assigned when a PR is both.
        for (alias, reason) in
            [("reviewRequested", ReviewReason::ReviewRequested), ("assigned", ReviewReason::Assigned)]
        {
            let nodes =
                root.pointer(&format!("/{alias}/nodes")).and_then(|n| n.as_array()).cloned().unwrap_or_default();
            for n in nodes {
                if let Some(item) = parse_review_node(&n, reason) {
                    if seen.insert(item.id.clone()) {
                        out.push(item);
                    }
                }
            }
        }
        Ok(out)
    }
}

/// Build a `ReviewItem` from a GraphQL PullRequest search node.
fn parse_review_node(n: &serde_json::Value, reason: ReviewReason) -> Option<ReviewItem> {
    let repo = n.pointer("/repository/nameWithOwner").and_then(|x| x.as_str())?.to_string();
    let number = n.get("number").and_then(|x| x.as_i64())?;
    let contexts: Vec<serde_json::Value> = n
        .pointer("/commits/nodes/0/commit/statusCheckRollup/contexts/nodes")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut c| {
            if let Some(name) =
                c.pointer("/checkSuite/workflowRun/workflow/name").and_then(|x| x.as_str()).map(str::to_string)
            {
                if let Some(obj) = c.as_object_mut() {
                    obj.insert("workflowName".into(), serde_json::Value::String(name));
                }
            }
            c
        })
        .collect();
    let (_checks, rollup) = crate::git::parse_rollup(&contexts);
    Some(ReviewItem {
        id: format!("{repo}#{number}"),
        account_id: String::new(),
        repo,
        number,
        title: n.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        url: n.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        author: n.pointer("/author/login").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        author_avatar: n.pointer("/author/avatarUrl").and_then(|x| x.as_str()).map(str::to_string),
        reason,
        head_ref: n.get("headRefName").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        rollup,
        is_draft: n.get("isDraft").and_then(|x| x.as_bool()).unwrap_or(false),
        updated_at: n.get("updatedAt").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        project_id: None,
    })
}

/// Build a `PrSummary` from a GraphQL PullRequest node (search or detail).
fn parse_pr_summary(n: &serde_json::Value, bucket: &str) -> Option<PrSummary> {
    let number = n.get("number").and_then(|x| x.as_i64())?;
    let repo = n.pointer("/repository/nameWithOwner").and_then(|x| x.as_str()).unwrap_or("").to_string();
    Some(PrSummary {
        number,
        title: n.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        url: n.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        author: n.pointer("/author/login").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        author_avatar: n.pointer("/author/avatarUrl").and_then(|x| x.as_str()).map(str::to_string),
        repo,
        head_ref: n.get("headRefName").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        base_ref: n.get("baseRefName").and_then(|x| x.as_str()).unwrap_or("main").to_string(),
        is_fork: n.get("isCrossRepository").and_then(|x| x.as_bool()).unwrap_or(false),
        is_draft: n.get("isDraft").and_then(|x| x.as_bool()).unwrap_or(false),
        updated_at: n.get("updatedAt").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        bucket: bucket.to_string(),
    })
}

/// Three aliased repo-scoped searches (mine / review-requested / assigned).
const LIST_PRS_QUERY: &str = r#"
query($mine:String!,$review:String!,$assigned:String!){
  mine: search(query:$mine, type:ISSUE, first:30){ nodes{ ...prsum } }
  review: search(query:$review, type:ISSUE, first:30){ nodes{ ...prsum } }
  assigned: search(query:$assigned, type:ISSUE, first:30){ nodes{ ...prsum } }
}
fragment prsum on PullRequest {
  number title url isDraft isCrossRepository updatedAt headRefName baseRefName
  repository{ nameWithOwner }
  author{ login avatarUrl }
}"#;

/// Detail for a single PR (head/base refs, fork flag).
const PR_DETAIL_QUERY: &str = r#"
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number title url isDraft isCrossRepository updatedAt headRefName baseRefName
      repository{ nameWithOwner }
      author{ login avatarUrl }
    }
  }
}"#;

/// Two aliased searches (review-requested + assigned) with a shared PR fragment.
const REVIEW_INBOX_QUERY: &str = r#"
query{
  reviewRequested: search(query:"is:open is:pr review-requested:@me archived:false", type:ISSUE, first:30){
    nodes{ ...pr }
  }
  assigned: search(query:"is:open is:pr assignee:@me archived:false", type:ISSUE, first:30){
    nodes{ ...pr }
  }
}
fragment pr on PullRequest {
  number title url isDraft updatedAt headRefName
  repository{ nameWithOwner }
  author{ login avatarUrl }
  commits(last:1){ nodes{ commit{ statusCheckRollup{ contexts(first:100){ nodes{
    __typename
    ... on CheckRun{ name status conclusion detailsUrl checkSuite{ workflowRun{ workflow{ name } } } }
    ... on StatusContext{ context state targetUrl }
  }}}}}}
}"#;

/// GraphQL for a branch's newest PR + its head commit's check rollup.
const PR_STATUS_QUERY: &str = r#"
query($owner:String!,$name:String!,$branch:String!){
  repository(owner:$owner,name:$name){
    pullRequests(headRefName:$branch,first:1,states:[OPEN,MERGED,CLOSED],orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{
        number url state headRefName headRefOid
        commits(last:1){ nodes{ commit{ statusCheckRollup{ contexts(first:100){ nodes{
          __typename
          ... on CheckRun{ name status conclusion detailsUrl checkSuite{ workflowRun{ workflow{ name } } } }
          ... on StatusContext{ context state targetUrl }
        }}}}}}
      }
    }
  }
}"#;

const PR_STATUS_BY_NUMBER_QUERY: &str = r#"
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number url state headRefName headRefOid
      commits(last:1){ nodes{ commit{ statusCheckRollup{ contexts(first:100){ nodes{
        __typename
        ... on CheckRun{ name status conclusion detailsUrl checkSuite{ workflowRun{ workflow{ name } } } }
        ... on StatusContext{ context state targetUrl }
      }}}}}}
    }
  }
}"#;

/// Map an octocrab error to a short string, flagging auth failures so callers
/// can mark the account as needing re-auth.
fn map_err(e: octocrab::Error) -> String {
    if let octocrab::Error::GitHub { source, .. } = &e {
        // 401/403 surface here; the manager inspects the message for "401".
        return format!("GitHub API error: {}", source.message);
    }
    format!("GitHub request failed: {e}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The PR node shape shared by both status queries (by-branch and
    /// by-number), as returned by GitHub GraphQL — verified live against
    /// microsoft/vscode#200000.
    #[test]
    fn parses_pr_status_node() {
        let pr = serde_json::json!({
            "number": 666,
            "url": "https://github.com/o/r/pull/666",
            "state": "OPEN",
            "headRefName": "feature/messages-conversation",
            "headRefOid": "abc123",
            "commits": { "nodes": [ { "commit": { "statusCheckRollup": { "contexts": { "nodes": [
                { "__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "SUCCESS",
                  "detailsUrl": "https://ci/1",
                  "checkSuite": { "workflowRun": { "workflow": { "name": "CI" } } } },
                { "__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE",
                  "detailsUrl": "https://ci/2",
                  "checkSuite": { "workflowRun": { "workflow": { "name": "CI" } } } }
            ] } } } } ] }
        });
        let s = parse_pr_status(&pr);
        assert_eq!(s.number, 666);
        assert_eq!(s.state, "OPEN");
        assert_eq!(s.head_branch, "feature/messages-conversation");
        assert_eq!(s.head_sha, "abc123");
        assert_eq!(s.checks.len(), 2);
        assert_eq!(s.rollup, "failure", "one failing check fails the rollup");
    }

    /// A PR with no checks yet (fresh push) must not panic and rolls up "none".
    #[test]
    fn parses_pr_status_without_rollup() {
        let pr = serde_json::json!({
            "number": 1, "url": "u", "state": "OPEN",
            "headRefName": "b", "headRefOid": "s",
            "commits": { "nodes": [ { "commit": { "statusCheckRollup": null } } ] }
        });
        let s = parse_pr_status(&pr);
        assert_eq!(s.checks.len(), 0);
        assert_eq!(s.rollup, "none");
    }
}
