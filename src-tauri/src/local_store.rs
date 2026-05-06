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
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct LocalStore {
    pub instances: Vec<LocalInstance>,
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
