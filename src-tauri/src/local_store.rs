use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
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
    pub created_at: String,
    pub updated_at: String,
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
}

// ── Audit helpers ──────────────────────────────────────────────────────────

pub fn append_audit_event(app_handle: &tauri::AppHandle, event: AuditEvent) {
    let mut store = load_store(app_handle);
    store.audit_log.push(event);
    save_store(app_handle, &store).ok();
}

// ── Store helpers ──────────────────────────────────────────────────────────

fn store_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut path = app_handle
        .path()
        .app_data_dir()
        .expect("Could not resolve app data directory");
    fs::create_dir_all(&path).ok();
    path.push("local_store.json");
    path
}

pub fn load_store(app_handle: &tauri::AppHandle) -> LocalStore {
    let path = store_path(app_handle);
    if !path.exists() {
        return LocalStore::default();
    }
    let raw = fs::read_to_string(&path).unwrap_or_default();
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_store(app_handle: &tauri::AppHandle, store: &LocalStore) -> Result<(), String> {
    let path = store_path(app_handle);
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
