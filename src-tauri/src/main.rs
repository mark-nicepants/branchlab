// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Process mode: `branchlab mcp-tasks` serves the task board over MCP
    // stdio (spawned by opencode per session) — no window, no tauri.
    if std::env::args().nth(1).as_deref() == Some("mcp-tasks") {
        branchlab_lib::run_mcp_tasks();
        return;
    }
    branchlab_lib::run()
}
