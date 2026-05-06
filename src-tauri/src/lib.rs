mod commands;
mod local_store;

use std::sync::Mutex;
use commands::docker::DockerMode;

/// Global app state shared across all Tauri commands.
/// Tracks the detected Docker execution mode so provisioning
/// commands know whether to run `docker ...` or `wsl docker ...`.
pub struct AppState {
    pub docker_mode: Mutex<DockerMode>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            docker_mode: Mutex::new(DockerMode::None),
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::docker::detect_docker,
            commands::instances::create_local_postgres,
            commands::instances::list_local_instances,
            commands::instances::start_local_instance,
            commands::instances::stop_local_instance,
            commands::instances::delete_local_instance,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

