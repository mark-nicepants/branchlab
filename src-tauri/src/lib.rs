mod commands;
mod env;
mod git;
mod project;
mod server;

use project::Registry;
use server::ServerManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            app.manage(servers);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            env::probe_environment,
            commands::add_project,
            commands::list_projects,
            commands::remove_project,
            commands::list_branches,
            commands::add_worktree,
            commands::remove_workspace,
            commands::list_workspaces,
            commands::rename_workspace,
            commands::workspace_diff_stat,
            commands::start_server,
            commands::stop_server,
            commands::server_status,
            commands::list_servers,
            commands::touch_server,
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
