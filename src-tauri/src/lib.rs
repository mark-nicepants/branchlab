mod chat;
mod commands;
mod config;
mod engine;
mod env;
mod git;
mod github;
mod logx;
mod path;
mod project;
mod run;
mod server;
mod supervisor;
mod telemetry;
mod watcher;

use github::GithubManager;
use project::Registry;
use server::ServerManager;
use supervisor::Supervisor;
use tauri::Manager;
use watcher::GitWatcher;

/// Current time in epoch milliseconds. Saturates to 0 before the epoch.
pub(crate) fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Repair PATH first: a Finder/Dock-launched .app gets a minimal PATH that
    // omits where `opencode` lives, so the env probe and server spawn would
    // both fail. Must run before anything resolves an external binary.
    path::fix_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Persist the project registry and store worktrees under app data.
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir).ok();
            // Backend debug log — a single tailable file under app data. Init
            // early so every subsystem below logs to it. Truncated per launch.
            logx::init(dir.join("branchlab.log"));
            let registry = Registry::load(dir.join("registry.json"), dir.join("worktrees"), dir.join("quick-chats"));
            app.manage(registry);

            // Anonymous usage telemetry (Umami). Opt-out persists as a marker
            // file; the frontend router reports pageviews through commands.
            let telemetry = telemetry::Telemetry::new(&dir);
            telemetry.event("app_open", "/", None);
            app.manage(telemetry);

            let servers = ServerManager::new();
            servers.spawn_reaper();
            app.manage(servers.clone());

            // Run/preview: user-defined dev-server scripts per workspace
            // (see docs/design/run-preview.md).
            app.manage(run::RunManager::new(app.handle().clone()));

            // Backend orchestration: a filesystem watcher pushes git state, and
            // a supervisor consumes each server's SSE + drives the PR autofix
            // loop for the active and all autofix-enabled workspaces. Both push
            // to the UI via events (see watcher.rs / supervisor.rs). This
            // replaces the frontend's polling + JS autofix state machine.
            let git_watcher = GitWatcher::new(app.handle().clone());
            app.manage(git_watcher.clone());
            // Seed watches off-thread so the per-workspace git recompute doesn't
            // block startup (the initial emit has no listener yet anyway; the
            // frontend seeds via `get_sidebar_snapshot` once mounted, which
            // computes any diff stat the watcher hasn't cached yet).
            let seed_handle = app.handle().clone();
            std::thread::spawn(move || {
                for w in seed_handle.state::<Registry>().all_workspaces() {
                    // Quick chats have no git state to watch.
                    if w.kind != project::WorkspaceKind::QuickChat {
                        git_watcher.watch(&w.id, &w.path);
                    }
                }
            });

            // GitHub subsystem: accounts (auth via isolated `gh`), identity,
            // API-backed PR status, and the cross-repo review inbox. Owns the
            // account store + per-account API clients and pushes github:* events.
            let github_dir = dir.join("github");
            std::fs::create_dir_all(&github_dir).ok();
            let github = GithubManager::load(app.handle().clone(), github_dir);
            github.spawn();
            app.manage(github.clone());

            // Chat subsystem: owns the ACP engine per workspace, the persistent
            // SQLite transcript cache, the turn lifecycle, and the chat:* deltas.
            let chat = chat::manager::ChatManager::new(app.handle().clone(), dir.join("chat.db"))?;
            app.manage(chat.clone());

            let supervisor = Supervisor::new(app.handle().clone(), chat, github);
            supervisor.spawn();
            app.manage(supervisor);

            // The window starts hidden to avoid a white flash; the frontend
            // shows it after first paint. This is a safety net so a failed
            // frontend can't leave the window invisible forever.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.show();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            env::probe_environment,
            telemetry::telemetry_pageview,
            telemetry::telemetry_event,
            telemetry::telemetry_get_enabled,
            telemetry::telemetry_set_enabled,
            commands::add_project,
            commands::list_projects,
            commands::remove_project,
            commands::list_branches,
            commands::create_workspace,
            commands::create_quick_chat,
            commands::create_workspace_from_pr,
            commands::list_project_prs,
            commands::update_project,
            commands::get_project_prompts,
            commands::remove_workspace,
            commands::list_workspaces,
            commands::rename_workspace,
            commands::rename_workspace_branch,
            commands::clear_init_prompt,
            commands::workspace_diff_stat,
            commands::workspace_changes,
            commands::workspace_file_diff,
            commands::workspace_files,
            commands::read_file,
            commands::discard_file,
            commands::commit_workspace,
            commands::merge_workspace,
            commands::push_workspace,
            commands::create_workspace_pr,
            commands::workspace_pr_status,
            commands::github_detect_account,
            commands::set_active_workspace,
            commands::set_autofix_mode,
            commands::get_sidebar_snapshot,
            commands::refresh_pr_status,
            commands::request_git_refresh,
            commands::list_remotes,
            commands::workspace_tools,
            commands::mcp_connect,
            commands::mcp_disconnect,
            commands::run_start,
            commands::run_stop,
            commands::run_state,
            commands::start_server,
            commands::stop_server,
            commands::server_status,
            commands::list_servers,
            commands::touch_server,
            commands::restart_server,
            commands::read_config,
            commands::write_config,
            commands::get_default_model,
            commands::set_default_model,
            commands::open_devtools,
            commands::open_external,
            commands::log_path,
            github::commands::github_list_accounts,
            github::commands::github_remove_account,
            github::commands::github_start_device_login,
            github::commands::github_cancel_login,
            github::commands::github_add_account_with_token,
            github::commands::github_review_inbox,
            github::commands::github_refresh_review_inbox,
            github::commands::resync_github,
            chat::commands::chat_open,
            chat::commands::chat_history,
            chat::commands::chat_send,
            chat::commands::chat_generate_title,
            chat::commands::chat_abort,
            chat::commands::chat_set_config,
            chat::commands::chat_answer_permission,
            chat::commands::chat_new_session,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Kill all opencode servers and run processes when the app exits.
            if let tauri::RunEvent::Exit = event {
                app.state::<ServerManager>().shutdown_all();
                app.state::<run::RunManager>().shutdown_all();
            }
        });
}
