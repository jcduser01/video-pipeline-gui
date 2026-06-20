//! Video-Pipeline Control Tower — Rust core (Tauri).
//!
//! Module map (SADD §2.2):
//!   * `schema`      — schema gateway: load / validate (meta-schema + references) / normalize
//!   * `scheduler`   — the hard core: DAG, skip-rewire, fail-cascade, leveling
//!   * `command`     — argv assembly (the process contract)
//!   * `supervisor`  — async process spawn, line streaming, artifact verification, cancel
//!   * `state`       — kv store (paths, projects, per-project session, theme)
//!   * `commands`    — the Tauri IPC surface + event forwarding
//!
//! The core owns all real complexity; the webview is pure presentation. The
//! pipeline package imports nothing from here (one-way dependency, SADD §9.1).

pub mod command;
pub mod commands;
pub mod scheduler;
pub mod schema;
pub mod state;
pub mod supervisor;

use tauri::Manager;

/// Build and run the desktop application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let ctx = commands::make_ctx(&app.handle());
            app.manage(ctx);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_schema,
            commands::set_schema_path,
            commands::resolve_argv,
            commands::build_plan,
            commands::run_plan,
            commands::cancel_task,
            commands::list_present_artifacts,
            commands::read_state,
            commands::write_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the control-tower application");
}
