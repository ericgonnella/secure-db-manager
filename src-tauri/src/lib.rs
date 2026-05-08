mod app_context;
mod commands;
mod event_emitter;
mod local_store;
pub mod secrets;

#[cfg(feature = "server")]
pub mod server;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use commands::docker::DockerMode;

pub use app_context::AppContext;

/// Global app state shared across all Tauri commands.
/// Tracks the detected Docker execution mode so provisioning
/// commands know whether to run `docker ...` or `wsl docker ...`.
///
/// Fields are wrapped in `Arc<Mutex<_>>` so they can be borrowed cheaply by
/// `AppContext` (which is also used by the headless `baseport-server` HTTP
/// binary).
pub struct AppState {
    pub docker_mode: Arc<Mutex<DockerMode>>,
    /// Long-running child processes (cloudflared, ngrok) keyed by exposure id.
    /// Stored as raw Child handles so we can kill them on teardown.
    pub exposure_children: Arc<Mutex<HashMap<String, std::process::Child>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Desktop mode uses the OS keyring for secrets; the HTTP server binary
    // configures an encrypted-file backend instead at startup.
    secrets::configure(secrets::SecretBackend::Keyring);

    tauri::Builder::default()
        .manage(AppState {
            docker_mode: Arc::new(Mutex::new(DockerMode::None)),
            exposure_children: Arc::new(Mutex::new(HashMap::new())),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::docker::detect_docker,
            commands::instances::create_local_instance,
            commands::instances::setup_pocketbase_superuser,
            commands::instances::list_local_instances,
            commands::instances::list_audit_logs,
            commands::instances::start_local_instance,
            commands::instances::stop_local_instance,
            commands::instances::delete_local_instance,
            commands::instances::get_instance_credentials,
            commands::instances::set_instance_password,
            commands::instances::reset_instance_password,
            commands::instances::get_container_logs,
            commands::instances::test_connection,
            commands::instances::backup_instance,
            commands::instances::restore_instance,
            commands::instances::list_backups,
            commands::instances::delete_backup,
            commands::hosts::add_remote_host,
            commands::hosts::list_remote_hosts,
            commands::hosts::delete_remote_host,
            commands::hosts::get_remote_host_credentials,
            commands::hosts::set_remote_host_password,
            commands::hosts::test_remote_connection,
            commands::exposure::preview_exposure,
            commands::exposure::create_exposure,
            commands::exposure::list_exposures,
            commands::exposure::remove_exposure,
            commands::exposure::check_tool_available,
            commands::exposure::download_and_install_tool,
            commands::exposure::add_firewall_rule,
            commands::exposure::get_public_ip,
            commands::exposure::reprovision_cloudflare_exposures,
            commands::exposure::regenerate_cloudflare_exposure,
            commands::config::get_data_dir,
            commands::config::open_data_dir,
            commands::config::clear_audit_log,
            commands::config::export_backup,
            commands::config::open_backup_folder,
            commands::web_apps::create_web_app,
            commands::web_apps::list_web_apps,
            commands::web_apps::start_web_app,
            commands::web_apps::stop_web_app,
            commands::web_apps::delete_web_app,
            commands::web_apps::deploy_web_app,
            commands::web_apps::get_web_app_logs,
            commands::web_apps::update_web_app_linked_instances,
            commands::web_apps::get_web_app_connection_info,
            commands::web_apps::rebuild_web_app,
            commands::web_apps::detect_web_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

