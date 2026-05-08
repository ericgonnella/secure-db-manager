use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(feature = "desktop")]
use tauri::Manager;

// ── Data types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalInstance {
    pub id: String,
    pub name: String,
    pub service_type: String,
    pub environment: String,
    pub container_name: String,
    pub volume_name: String,
    pub host: String,
    pub port: u16,
    pub db_name: Option<String>,
    pub username: String,
    pub status: String,
    pub created_at: String,
    #[serde(default = "default_project_id")]
    pub project_id: String,
}

fn default_project_id() -> String {
    "default".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuditEvent {
    pub id: String,
    pub timestamp: String,
    pub action: String,
    pub instance_id: String,
    pub instance_name: String,
    pub service_type: String,
    pub environment: String,
    pub outcome: String,
    pub detail: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BackupRecord {
    pub id: String,
    pub instance_id: String,
    pub created_at: String,
    pub file_path: String,
    pub size_bytes: u64,
    pub note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RemoteHost {
    pub id: String,
    pub name: String,
    pub service_type: String,
    pub environment: String,
    pub host: String,
    pub port: u16,
    pub db_name: Option<String>,
    pub username: String,
    pub ssl_mode: String,        // "disable" | "require" | "verify-ca" | "verify-full"
    pub auth_type: String,       // "password" | "ssh-tunnel"
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_user: Option<String>,
    pub ssh_key_path: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
    #[serde(default = "default_project_id")]
    pub project_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Exposure {
    pub id: String,
    pub instance_id: String,
    /// "direct" | "cloudflare" | "ngrok" | "nginx"
    pub method: String,
    /// "active" | "inactive" | "error"
    pub status: String,
    /// Public endpoint string (URL or host:port). May be empty until the tunnel reports it.
    pub external_endpoint: Option<String>,
    /// External port (only meaningful for direct/nginx).
    pub external_port: Option<u16>,
    /// Cloudflare tunnel UUID, ngrok session id, or other method-specific identifier.
    pub provider_id: Option<String>,
    /// Background process PID (cloudflared, ngrok). None for stateless methods.
    pub pid: Option<u32>,
    /// Optional custom hostname (cloudflare/nginx).
    pub hostname: Option<String>,
    /// Last error message if status == "error".
    pub error: Option<String>,
    /// Windows Firewall rule name recorded when the user ran "Configure firewall".
    /// Used to remove the rule automatically on teardown.
    #[serde(default)]
    pub firewall_rule_name: Option<String>,
    /// "instance" (default) or "web_app" — controls whether `instance_id`
    /// resolves against `LocalStore::instances` or `LocalStore::web_apps`.
    #[serde(default = "default_target_type")]
    pub target_type: String,
    pub created_at: String,
    pub updated_at: String,
}

fn default_target_type() -> String {
    "instance".to_string()
}

fn default_build_output_dir() -> String {
    String::new()
}

fn default_container_type() -> String {
    "nginx".to_string()
}

fn default_nodejs_port() -> u16 {
    3000
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WebApp {
    pub id: String,
    pub name: String,
    pub container_name: String,
    /// Absolute path to the per-app config dir (contains nginx.conf + www/).
    pub config_path: String,
    pub port: u16,
    /// "dev" — bind-mount `src_path` read-only.
    /// "deploy" — populate a named volume via `docker cp`.
    pub mode: String,
    /// Absolute host path to the project root (dev) or deploy source folder.
    pub src_path: Option<String>,
    /// Relative output dir inside `src_path` produced by the build step (e.g. "dist").
    /// nginx is bound to `src_path/build_output_dir`. Empty string → serve src_path directly.
    #[serde(default = "default_build_output_dir")]
    pub build_output_dir: String,
    /// Shell command to run before starting/restarting (e.g. "pnpm build").
    /// Runs in `src_path` on the host. `None` = no build step.
    #[serde(default)]
    pub build_command: Option<String>,
    /// "nginx" (default) — serve static files via nginx:alpine.
    /// "nodejs" — run the project inside a node:lts-alpine container.
    #[serde(default = "default_container_type")]
    pub container_type: String,
    /// For `container_type = "nodejs"`: command run inside the container to start the app.
    #[serde(default)]
    pub nodejs_start_command: Option<String>,
    /// For `container_type = "nodejs"`: port the app listens on inside the container.
    #[serde(default = "default_nodejs_port")]
    pub nodejs_app_port: u16,
    pub status: String,
    #[serde(default)]
    pub linked_instance_ids: Vec<String>,
    #[serde(default = "default_project_id")]
    pub project_id: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct LocalStore {
    pub instances: Vec<LocalInstance>,
    #[serde(default)]
    pub audit_log: Vec<AuditEvent>,
    #[serde(default)]
    pub backups: Vec<BackupRecord>,
    #[serde(default)]
    pub remote_hosts: Vec<RemoteHost>,
    #[serde(default)]
    pub exposures: Vec<Exposure>,
    #[serde(default)]
    pub web_apps: Vec<WebApp>,
}

// ── Audit helpers ──────────────────────────────────────────────────────────

/// Path-based core: append an audit event using just the data directory.
/// Used by the HTTP server binary which has no `AppHandle`.
pub fn append_audit_event_at(data_dir: &Path, event: AuditEvent) {
    let mut store = load_store_at(data_dir);
    store.audit_log.push(event);
    save_store_at(data_dir, &store).ok();
}

/// Backward-compatible wrapper for existing Tauri command call-sites.
#[cfg(feature = "desktop")]
pub fn append_audit_event(app_handle: &tauri::AppHandle, event: AuditEvent) {
    append_audit_event_at(&resolve_data_dir(app_handle), event);
}

// ── Store helpers ──────────────────────────────────────────────────────────

/// Resolve the per-mode data directory for a Tauri `AppHandle`. The HTTP
/// server constructs its data dir from the `BASEPORT_DATA_DIR` env var and
/// goes straight to the `_at` variants instead.
#[cfg(feature = "desktop")]
fn resolve_data_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    let path = app_handle
        .path()
        .app_data_dir()
        .expect("Could not resolve app data directory");
    fs::create_dir_all(&path).ok();
    path
}

fn store_path_at(data_dir: &Path) -> PathBuf {
    fs::create_dir_all(data_dir).ok();
    data_dir.join("local_store.json")
}

#[cfg(feature = "desktop")]
fn store_path(app_handle: &tauri::AppHandle) -> PathBuf {
    store_path_at(&resolve_data_dir(app_handle))
}

/// Path-based core: load the store from the given data directory.
pub fn load_store_at(data_dir: &Path) -> LocalStore {
    let path = store_path_at(data_dir);
    if !path.exists() {
        return LocalStore::default();
    }
    let raw = fs::read_to_string(&path).unwrap_or_default();
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Path-based core: persist the store to the given data directory.
pub fn save_store_at(data_dir: &Path, store: &LocalStore) -> Result<(), String> {
    let path = store_path_at(data_dir);
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// Backward-compatible wrapper for existing Tauri command call-sites.
#[cfg(feature = "desktop")]
pub fn load_store(app_handle: &tauri::AppHandle) -> LocalStore {
    load_store_at(&resolve_data_dir(app_handle))
}

/// Backward-compatible wrapper for existing Tauri command call-sites.
#[cfg(feature = "desktop")]
pub fn save_store(app_handle: &tauri::AppHandle, store: &LocalStore) -> Result<(), String> {
    save_store_at(&resolve_data_dir(app_handle), store)
}

// Re-export for callers that want the resolved store path (rare).
#[cfg(feature = "desktop")]
#[allow(dead_code)]
pub fn store_path_for(app_handle: &tauri::AppHandle) -> PathBuf {
    store_path(app_handle)
}
