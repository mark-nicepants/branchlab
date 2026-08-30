//! The Rust↔TS wire-contract drift guard.
//!
//! `cargo test --lib` (this module) is the generator: it serializes a fully
//! populated exemplar of every wire DTO (every `Option` = `Some`, every `Vec`
//! non-empty, enums on an interesting variant) into
//! `src/lib/__fixtures__/contract.gen.ts`, where each exemplar is annotated
//! with its TS mirror type. `tsc` (`npm run build`) is then the actual contract
//! check — a renamed/removed/re-typed field on either side fails the frontend
//! build — and `src/lib/contract.test.ts` spot-checks key casing at runtime.
//!
//! Generated TS (not JSON) on purpose: `tsc` widens JSON-module strings to
//! `string`, which can never satisfy the TS union fields ("idle" | "working",
//! entry `type` tags, …); annotated literals in a .ts file check exactly.
//! Commit the regenerated file whenever this test changes it.

use serde::Serialize;

use crate::chat::events as chat_events;
use crate::chat::model::*;
use crate::git;
use crate::github::model::{AccountView, LoginEvent, LoginPhase, ReviewItem, ReviewReason};
use crate::project::{AutofixMode, Project, ProjectPrompts, ProjectView, RunSettings, SetupState, WorkspaceKind};
use crate::supervisor::{Activity, NotifyPayload, Phase, PrPayload, SessionPayload};
use crate::tasks;

/// Fixed timestamp so regeneration is deterministic (committed file, no churn).
const T: i64 = 1_700_000_000_000;

fn pr_check() -> git::PrCheck {
    git::PrCheck {
        name: "test".into(),
        bucket: git::CheckBucket::Failure,
        state: "FAILURE".into(),
        url: Some("https://ci.example/run/1".into()),
        workflow: Some("CI".into()),
    }
}

fn pr_status() -> git::PrStatus {
    git::PrStatus {
        number: 42,
        url: "https://github.com/acme/repo/pull/42".into(),
        state: "OPEN".into(),
        head_branch: "feature/x".into(),
        head_sha: "abc123".into(),
        checks: vec![pr_check()],
        rollup: git::Rollup::Failure,
    }
}

fn workspace() -> crate::project::Workspace {
    crate::project::Workspace {
        id: "ws-1".into(),
        project_id: "p1".into(),
        kind: WorkspaceKind::Worktree,
        path: "/tmp/worktrees/p1/feature-x".into(),
        branch: Some("feature/x".into()),
        name: Some("Add dark mode".into()),
        base_branch: Some("main".into()),
        init_prompt: Some("Set up the workspace.".into()),
        autofix_mode: AutofixMode::Super,
        model: Some("anthropic/claude-opus-4-8".into()),
        effort: Some("high".into()),
        pr_number: Some(42),
        pr_is_fork: true,
        pr: Some(pr_status()),
        setup: SetupState::Ready,
    }
}

fn diff_stat() -> git::DiffStat {
    git::DiffStat { files: 3, insertions: 42, deletions: 7 }
}

fn session_payload() -> SessionPayload {
    SessionPayload {
        workspace_id: "ws-1".into(),
        activity: Activity::Working,
        awaiting_input: true,
        needs_attention: true,
        error: Some("the last turn failed".into()),
    }
}

fn pr_payload() -> PrPayload {
    PrPayload {
        workspace_id: "ws-1".into(),
        status: Some(pr_status()),
        phase: Phase::AwaitingPush,
        attempts: 2,
        mode: AutofixMode::Super,
        error: Some("poll failed".into()),
    }
}

fn usage() -> UsageInfo {
    UsageInfo {
        input: Some(1200),
        output: Some(340),
        reasoning: Some(80),
        cache_read: Some(9000),
        cache_write: Some(100),
    }
}

fn blocks() -> Vec<Block> {
    vec![
        Block::Text { block_id: "b1".into(), text: "Fixed the failing test.".into() },
        Block::Reasoning { block_id: "b2".into(), text: "The bug is in config parsing…".into() },
        Block::Tool(Box::new(ToolBlock {
            block_id: "b3".into(),
            call_id: "c3".into(),
            name: "edit".into(),
            title: Some("Edit config.rs".into()),
            status: ToolStatus::Completed,
            input: serde_json::json!({ "filePath": "src/config.rs" }),
            output: Some("ok".into()),
            diff: Some(DiffBlock { path: "src/config.rs".into(), old_text: Some("a".into()), new_text: "b".into() }),
            locations: vec![ToolLocation { path: "src/config.rs".into(), line: Some(88) }],
            raw_output: Some(serde_json::json!({ "exitCode": 0 })),
            started_at: Some(T),
            ended_at: Some(T + 1200),
        })),
        Block::File {
            block_id: "b4".into(),
            name: Some("screenshot.png".into()),
            mime: Some("image/png".into()),
            url: "data:image/png;base64,AAAA".into(),
        },
    ]
}

fn summary() -> CollapseSummary {
    CollapseSummary {
        collapsed: true,
        step_count: 3,
        files_edited: vec!["src/config.rs".into()],
        commands_run: 1,
        headline: "Edited 1 file · ran 1 command".into(),
    }
}

fn user_entry() -> Entry {
    Entry::User(UserEntry {
        seq: 1,
        entry_id: "u1".into(),
        display: "Fix the failing test".into(),
        sent: "Fix the failing test (expanded)".into(),
        attachments: vec![Attachment {
            mime: "image/png".into(),
            url: "data:image/png;base64,AAAA".into(),
            filename: Some("shot.png".into()),
        }],
        model: Some("anthropic/claude-opus-4-8".into()),
        variant: Some("high".into()),
        agent: Some("build".into()),
        origin: TurnOrigin::User,
        created_at: T,
    })
}

fn assistant_entry() -> Entry {
    Entry::Assistant(AssistantEntry {
        seq: 2,
        entry_id: "a1".into(),
        status: TurnStatus::Completed,
        origin: TurnOrigin::Autofix,
        blocks: blocks(),
        summary: summary(),
        usage: Some(usage()),
        started_at: T,
        ended_at: Some(T + 9000),
    })
}

fn system_entry() -> Entry {
    Entry::System(SystemEntry {
        seq: 3,
        entry_id: "s1".into(),
        kind: SystemKind::Success,
        text: "PR #42 was merged — this workspace can be deleted.".into(),
        created_at: T,
        steps: vec![SetupStep {
            label: "Run setup script".into(),
            status: ToolStatus::Running,
            log: vec!["$ npm install".into()],
            started_at: Some(T),
            ended_at: Some(T + 500),
        }],
        action: Some(SystemAction::DeleteWorkspace),
    })
}

fn config_option() -> ConfigOption {
    ConfigOption {
        id: "model".into(),
        name: "Model".into(),
        description: Some("The model driving the session".into()),
        category: Some("model".into()),
        current_value: "anthropic/claude-opus-4-8".into(),
        choices: vec![ConfigChoice {
            value: "anthropic/claude-opus-4-8".into(),
            name: "Claude Opus 4.8".into(),
            description: Some("flagship".into()),
            group: Some("Anthropic".into()),
        }],
    }
}

fn command_info() -> chat_events::CommandInfo {
    chat_events::CommandInfo { name: "compress".into(), description: "Compress memory files".into() }
}

fn account_view() -> AccountView {
    AccountView {
        id: "github.com/octocat".into(),
        host: "github.com".into(),
        login: "octocat".into(),
        name: Some("The Octocat".into()),
        avatar_url: Some("https://avatars.example/1".into()),
        active: true,
        status: Some("Sign-in required".into()),
    }
}

fn review_item() -> ReviewItem {
    ReviewItem {
        id: "acme/repo#42".into(),
        account_id: "github.com/octocat".into(),
        repo: "acme/repo".into(),
        number: 42,
        title: "Add rate limiting".into(),
        url: "https://github.com/acme/repo/pull/42".into(),
        author: "alice".into(),
        author_avatar: Some("https://avatars.example/2".into()),
        reason: ReviewReason::ReviewRequested,
        head_ref: "feat/rate-limit".into(),
        rollup: git::Rollup::Pending,
        is_draft: true,
        updated_at: "2026-07-03T09:12:00Z".into(),
        project_id: Some("p1".into()),
    }
}

fn task() -> tasks::Task {
    tasks::Task {
        id: "t1".into(),
        number: 7,
        title: "Fix header contrast".into(),
        description: Some("On dark mode.".into()),
        project_id: Some("p1".into()),
        column_id: "c1".into(),
        position: 1024.0,
        workspace_id: Some("ws-1".into()),
        parent_id: Some("t0".into()),
        depends_on: vec!["t2".into()],
        estimate: Some(3.0),
        attachments: vec![tasks::TaskAttachment {
            id: "att-1".into(),
            name: "log.txt".into(),
            size: 48213,
            created_at: T,
        }],
        created_at: T,
        updated_at: T,
        deleted_at: Some(T),
    }
}

fn board_snapshot() -> tasks::BoardSnapshot {
    tasks::BoardSnapshot {
        columns: vec![tasks::Column {
            id: "c1".into(),
            name: "In progress".into(),
            role: tasks::ColumnRole::Active,
            position: 2048.0,
            updated_at: T,
            deleted_at: Some(T),
        }],
        tasks: vec![task()],
        estimate_unit: tasks::EstimateUnit::Tshirt,
    }
}

/// One `export const {name}: {ts_type} = {json};` block.
fn export<T: Serialize>(out: &mut String, name: &str, ts_type: &str, value: &T) {
    let json = serde_json::to_string_pretty(value).expect("fixture serializes");
    out.push_str(&format!("export const {name}: {ts_type} = {json};\n\n"));
}

#[test]
fn generate_contract_fixtures() {
    let mut out = String::from(
        "// GENERATED by `cargo test --lib` — src-tauri/src/contract_fixtures.rs. Do not edit.\n\
         // Each exemplar is the serde serialization of a Rust wire DTO, annotated with\n\
         // its TS mirror type: `tsc` (npm run build) type-checking this file IS the\n\
         // Rust<->TS contract check. src/lib/contract.test.ts spot-checks key casing.\n\
         import type {\n  Workspace,\n  ProjectView,\n  SidebarWorkspace,\n  ChatSnapshot,\n  Entry,\n  Block,\n  \
         UsageInfo,\n  ChatEntryEvent,\n  ChatBlockEvent,\n  ChatTurnEvent,\n  ChatPermissionEvent,\n  \
         ChatConfigEvent,\n  ChatResetEvent,\n  ChatContextEvent,\n  ChatCommandsEvent,\n  ChatCommand,\n  \
         ConfigOption,\n  GitPayload,\n  SessionPayload,\n  PrPayload,\n  PrStatus,\n  PrCheck,\n  \
         NotifyPayload,\n  TodosPayload,\n  Todo,\n  WorkspaceSetupPayload,\n  AccountsPayload,\n  \
         ReviewInboxPayload,\n  GitHubLoginEvent,\n  BoardSnapshot,\n  ActivityEntry,\n  UnlinkedTask,\n  \
         ServerInfo,\n  ToolsStatus,\n} from \"../types\";\n\n",
    );

    // ── Command returns / registry-backed shapes (legacy snake_case fields) ──
    export(&mut out, "workspace", "Workspace", &workspace());
    let project = Project {
        id: "p1".into(),
        name: "branchlab".into(),
        root_path: "/Users/me/code/branchlab".into(),
        default_branch: Some("main".into()),
        prompts: ProjectPrompts::default(),
        account_id: Some("github.com/octocat".into()),
        run: RunSettings { setup_script: Some("npm install".into()), teardown_script: Some("true".into()) },
        estimate_unit: Some(tasks::EstimateUnit::Tshirt),
    };
    export(&mut out, "projectView", "ProjectView", &ProjectView { project, workspaces: vec![workspace()] });
    export(
        &mut out,
        "sidebarWorkspace",
        "SidebarWorkspace",
        &crate::commands::SidebarWorkspace {
            workspace_id: "ws-1".into(),
            diff_stat: diff_stat(),
            session: session_payload(),
            pr: pr_payload(),
        },
    );
    export(
        &mut out,
        "chatSnapshot",
        "ChatSnapshot",
        &crate::chat::manager::ChatSnapshot {
            entries: vec![user_entry(), assistant_entry(), system_entry()],
            has_more: true,
            config: vec![config_option()],
            commands: vec![command_info()],
        },
    );
    export(&mut out, "entries", "Entry[]", &vec![user_entry(), assistant_entry(), system_entry()]);
    export(&mut out, "blocks", "Block[]", &blocks());
    export(&mut out, "usageInfo", "UsageInfo", &usage());
    export(&mut out, "configOption", "ConfigOption", &config_option());
    export(&mut out, "chatCommand", "ChatCommand", &command_info());
    export(
        &mut out,
        "serverInfo",
        "ServerInfo",
        &crate::server::ServerInfo {
            workspace_id: "ws-1".into(),
            base_url: "http://127.0.0.1:4096".into(),
            port: 4096,
        },
    );
    export(
        &mut out,
        "toolsStatus",
        "ToolsStatus",
        &crate::engine::opencode_http::ToolsStatus {
            mcp: vec![crate::engine::opencode_http::McpStatus {
                name: "playwright".into(),
                status: "failed".into(),
                error: Some("auth required".into()),
            }],
            lsp: vec![crate::engine::opencode_http::LspStatus {
                id: "typescript".into(),
                status: Some("running".into()),
            }],
        },
    );
    export(&mut out, "prStatus", "PrStatus", &pr_status());
    export(&mut out, "prCheck", "PrCheck", &pr_check());
    export(
        &mut out,
        "unlinkedTask",
        "UnlinkedTask",
        &tasks::UnlinkedTask { task_id: "t1".into(), title: "Fix header contrast".into() },
    );
    export(&mut out, "boardSnapshot", "BoardSnapshot", &board_snapshot());
    export(
        &mut out,
        "activityEntry",
        "ActivityEntry",
        &tasks::ActivityEntry {
            id: "act-1".into(),
            task_id: "t1".into(),
            kind: "comment".into(),
            body: "Looks right.".into(),
            actor: "agent".into(),
            created_at: T,
        },
    );

    // ── Event payloads (camelCase; serialized through the emit-shape structs) ──
    let entry = assistant_entry();
    export(
        &mut out,
        "chatEntryEvent",
        "ChatEntryEvent",
        &chat_events::EntryEvent { workspace_id: "ws-1", entry: &entry },
    );
    let block = &blocks()[2];
    export(
        &mut out,
        "chatBlockEvent",
        "ChatBlockEvent",
        &chat_events::BlockEvent { workspace_id: "ws-1", entry_seq: 2, block },
    );
    let s = summary();
    let u = usage();
    export(
        &mut out,
        "chatTurnEvent",
        "ChatTurnEvent",
        &chat_events::TurnEventPayload {
            workspace_id: "ws-1",
            entry_seq: 2,
            status: TurnStatus::AwaitingPermission,
            summary: &s,
            usage: Some(&u),
            ended_at: Some(T + 9000),
        },
    );
    let perm_options = vec![chat_events::PermChoiceDto {
        option_id: "allow".into(),
        name: "Allow once".into(),
        kind: "allowOnce".into(),
    }];
    export(
        &mut out,
        "chatPermissionEvent",
        "ChatPermissionEvent",
        &chat_events::PermissionEvent {
            workspace_id: "ws-1",
            entry_seq: 2,
            request_id: "perm-1",
            tool_call_id: "c3",
            title: Some("Allow git push?"),
            options: &perm_options,
        },
    );
    let options = vec![config_option()];
    export(
        &mut out,
        "chatConfigEvent",
        "ChatConfigEvent",
        &chat_events::ConfigEvent { workspace_id: "ws-1", options: &options },
    );
    export(&mut out, "chatResetEvent", "ChatResetEvent", &chat_events::ResetEvent { workspace_id: "ws-1" });
    export(
        &mut out,
        "chatContextEvent",
        "ChatContextEvent",
        &chat_events::ContextEvent { workspace_id: "ws-1", used: 12400, max: 200000 },
    );
    let commands = vec![command_info()];
    export(
        &mut out,
        "chatCommandsEvent",
        "ChatCommandsEvent",
        &chat_events::CommandsEvent { workspace_id: "ws-1", commands: &commands },
    );
    let todos = vec![chat_events::Todo { content: "Fix newline normalization".into(), status: "in_progress".into() }];
    export(&mut out, "todo", "Todo", &todos[0]);
    export(&mut out, "todosPayload", "TodosPayload", &chat_events::TodosEvent { workspace_id: "ws-1", todos: &todos });
    export(
        &mut out,
        "gitPayload",
        "GitPayload",
        &crate::watcher::GitPayload {
            workspace_id: "ws-1".into(),
            diff_stat: diff_stat(),
            changes: Some(vec![git::FileChange {
                path: "src/App.tsx".into(),
                status: "modified".into(),
                insertions: 10,
                deletions: 2,
            }]),
            branch: Some("feature/x".into()),
        },
    );
    export(&mut out, "sessionPayload", "SessionPayload", &session_payload());
    export(&mut out, "prPayload", "PrPayload", &pr_payload());
    export(
        &mut out,
        "notifyPayload",
        "NotifyPayload",
        &NotifyPayload { workspace_id: "ws-1".into(), kind: "task_review", task_title: Some("Fix header".into()) },
    );
    export(
        &mut out,
        "workspaceSetupPayload",
        "WorkspaceSetupPayload",
        &crate::setup::SetupEvent { workspace_id: "ws-1", running: false, ok: Some(true) },
    );
    let accounts = vec![account_view()];
    export(
        &mut out,
        "accountsPayload",
        "AccountsPayload",
        &crate::github::events::AccountsEvent { accounts: &accounts },
    );
    let items = vec![review_item()];
    export(
        &mut out,
        "reviewInboxPayload",
        "ReviewInboxPayload",
        &crate::github::events::ReviewInboxEvent { items: &items, refreshed_at: Some(T), error: Some("rate limited") },
    );
    export(
        &mut out,
        "gitHubLoginEvent",
        "GitHubLoginEvent",
        &LoginEvent {
            login_id: "login-1".into(),
            phase: LoginPhase::AwaitingCode,
            code: Some("WXYZ-1234".into()),
            url: Some("https://github.com/login/device".into()),
            account: Some(account_view()),
            error: Some("boom".into()),
        },
    );

    // The test IS the generator: failing to write must fail the test, and a
    // normal `cargo test --lib` run refreshes the committed fixture file.
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/__fixtures__");
    std::fs::create_dir_all(&dir).expect("create src/lib/__fixtures__");
    std::fs::write(dir.join("contract.gen.ts"), out).expect("write contract.gen.ts");
}
