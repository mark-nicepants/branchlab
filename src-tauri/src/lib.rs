mod commands;
mod config;
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
            commands::remove_workspace,
            commands::list_workspaces,
            commands::rename_workspace,
            commands::workspace_diff_stat,
            commands::workspace_changes,
            commands::workspace_file_diff,
            commands::discard_file,
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
