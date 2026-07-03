mod commands;
mod config;
mod env;
mod git;
mod opencode;
mod path;
mod project;
mod server;
mod supervisor;
mod watcher;

use project::Registry;
use server::ServerManager;
use supervisor::Supervisor;
use tauri::Manager;
use watcher::GitWatcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Repair PATH first: a Finder/Dock-launched .app gets a minimal PATH that
    // omits where `opencode` lives, so the env probe and server spawn would
    // both fail. Must run before anything resolves an external binary.
    path::fix_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Persist the project registry and store worktrees under app data.
            let dir = app.path().app_data_dir()?;
            let registry = Registry::load(dir.join("registry.json"), dir.join("worktrees"));
            app.manage(registry);

            let servers = ServerManager::new();
            servers.spawn_reaper();
            app.manage(servers.clone());

            // Backend orchestration: a filesystem watcher pushes git state, and
            // a supervisor consumes each server's SSE + drives the PR autofix
            // loop for the active and all autofix-enabled workspaces. Both push
            // to the UI via events (see watcher.rs / supervisor.rs). This
            // replaces the frontend's polling + JS autofix state machine.
            let git_watcher = GitWatcher::new(app.handle().clone());
            app.manage(git_watcher.clone());
            // Seed watches off-thread so the per-workspace git recompute doesn't
            // block startup (the initial emit has no listener yet anyway; the
            // frontend calls `resync` once mounted to get the first snapshot).
            let seed_handle = app.handle().clone();
            std::thread::spawn(move || {
                for w in seed_handle.state::<Registry>().all_workspaces() {
                    git_watcher.watch(&w.id, &w.path);
                }
            });

            let supervisor = Supervisor::new(app.handle().clone(), servers);
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
            commands::add_project,
            commands::list_projects,
            commands::remove_project,
            commands::list_branches,
            commands::create_workspace,
            commands::update_project,
            commands::get_project_prompts,
            commands::remove_workspace,
            commands::list_workspaces,
            commands::rename_workspace,
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
            commands::register_session,
            commands::set_active_workspace,
            commands::set_autofix_mode,
            commands::resync,
            commands::request_git_refresh,
            commands::list_remotes,
            commands::start_server,
            commands::stop_server,
            commands::server_status,
            commands::list_servers,
            commands::touch_server,
            commands::restart_server,
            commands::read_config,
            commands::write_config,
            commands::open_devtools,
            commands::open_external,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Kill all opencode servers when the app exits.
            if let tauri::RunEvent::Exit = event {
                app.state::<ServerManager>().shutdown_all();
            }
        });
}
