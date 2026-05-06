use crate::local_store::{load_store, save_store, LocalInstance};
use serde::Deserialize;
use std::process::Command;
use tauri::{AppHandle, Manager};

// ── Input types ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreatePostgresInput {
    pub name: String,
    pub version: String,
    pub port: u16,
    pub db_name: String,
    pub username: String,
    pub password: String,
    pub environment: String,
}

// ── Docker helpers ─────────────────────────────────────────────────────────

/// Run a docker command, optionally via wsl, based on detected mode.
fn docker_cmd(app: &AppHandle) -> Command {
    let state = app.state::<crate::AppState>();
    let mode = state.docker_mode.lock().unwrap().clone();
    match mode {
        crate::commands::docker::DockerMode::Wsl2 => {
            let mut cmd = Command::new("wsl");
            cmd.arg("docker");
            cmd
        }
        _ => Command::new("docker"),
    }
}

fn slugify(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn create_local_postgres(
    app: AppHandle,
    input: CreatePostgresInput,
) -> Result<LocalInstance, String> {
    // Validate inputs
    if input.name.trim().is_empty() {
        return Err("Instance name is required.".into());
    }
    if input.db_name.trim().is_empty() {
        return Err("Database name is required.".into());
    }
    if input.username.trim().is_empty() {
        return Err("Username is required.".into());
    }
    if input.password.len() < 8 {
        return Err("Password must be at least 8 characters.".into());
    }
    if input.port < 1024 {
        return Err("Port must be 1024 or higher.".into());
    }
    // Reject disallowed image versions to prevent injection
    let safe_version: String = input.version.chars()
        .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-')
        .collect();
    if safe_version.is_empty() || safe_version != input.version {
        return Err("Invalid version string.".into());
    }

    let slug = slugify(&input.name);
    let container_name = format!("sdm_{}_postgres", slug);
    let volume_name = format!("sdm_{}_pgdata", slug);
    let image = format!("postgres:{}-alpine", safe_version);
    let port_bind = format!("127.0.0.1:{}:5432", input.port);

    // Create the volume first
    let vol_out = docker_cmd(&app)
        .args(["volume", "create", &volume_name])
        .output()
        .map_err(|e| format!("Failed to run docker: {e}"))?;

    if !vol_out.status.success() {
        let err = String::from_utf8_lossy(&vol_out.stderr);
        return Err(format!("Failed to create volume: {err}"));
    }

    // Start the container
    let run_out = docker_cmd(&app)
        .args([
            "run", "-d",
            "--name", &container_name,
            "--restart", "unless-stopped",
            "-e", &format!("POSTGRES_DB={}", input.db_name),
            "-e", &format!("POSTGRES_USER={}", input.username),
            "-e", &format!("POSTGRES_PASSWORD={}", input.password),
            "-p", &port_bind,
            "-v", &format!("{}:/var/lib/postgresql/data", volume_name),
            "--label", &format!("app.securedbmanager.service_type=postgres"),
            "--label", &format!("app.securedbmanager.environment={}", input.environment),
            &image,
        ])
        .output()
        .map_err(|e| format!("Failed to run docker: {e}"))?;

    if !run_out.status.success() {
        let err = String::from_utf8_lossy(&run_out.stderr);
        // Clean up the volume we just created
        docker_cmd(&app)
            .args(["volume", "rm", &volume_name])
            .output()
            .ok();
        return Err(format!("Failed to start container: {err}"));
    }

    let id = format!("local_{}", uuid_v4());
    let now = chrono::Utc::now().to_rfc3339();

    let instance = LocalInstance {
        id: id.clone(),
        name: input.name.clone(),
        service_type: "postgres".into(),
        environment: input.environment.clone(),
        container_name: container_name.clone(),
        volume_name: volume_name.clone(),
        host: "127.0.0.1".into(),
        port: input.port,
        db_name: Some(input.db_name.clone()),
        username: input.username.clone(),
        status: "running".into(),
        created_at: now,
    };

    // Persist to local store
    let mut store = load_store(&app);
    store.instances.push(instance.clone());
    save_store(&app, &store)?;

    Ok(instance)
}

#[tauri::command]
pub async fn list_local_instances(app: AppHandle) -> Result<Vec<LocalInstance>, String> {
    let store = load_store(&app);
    Ok(store.instances)
}

#[tauri::command]
pub async fn start_local_instance(
    app: AppHandle,
    instance_id: String,
) -> Result<(), String> {
    let store = load_store(&app);
    let instance = store
        .instances
        .iter()
        .find(|i| i.id == instance_id)
        .ok_or("Instance not found.")?;

    let out = docker_cmd(&app)
        .args(["start", &instance.container_name])
        .output()
        .map_err(|e| format!("Failed to run docker: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Failed to start container: {err}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_local_instance(
    app: AppHandle,
    instance_id: String,
) -> Result<(), String> {
    let store = load_store(&app);
    let instance = store
        .instances
        .iter()
        .find(|i| i.id == instance_id)
        .ok_or("Instance not found.")?;

    let out = docker_cmd(&app)
        .args(["stop", &instance.container_name])
        .output()
        .map_err(|e| format!("Failed to run docker: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Failed to stop container: {err}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_local_instance(
    app: AppHandle,
    instance_id: String,
    delete_volume: bool,
) -> Result<(), String> {
    let mut store = load_store(&app);
    let pos = store
        .instances
        .iter()
        .position(|i| i.id == instance_id)
        .ok_or("Instance not found.")?;

    let instance = store.instances[pos].clone();

    // Stop + remove container (ignore errors if already gone)
    docker_cmd(&app)
        .args(["rm", "-f", &instance.container_name])
        .output()
        .ok();

    if delete_volume {
        docker_cmd(&app)
            .args(["volume", "rm", &instance.volume_name])
            .output()
            .ok();
    }

    store.instances.remove(pos);
    save_store(&app, &store)?;
    Ok(())
}

// ── Tiny UUID v4 (no external dep) ────────────────────────────────────────

fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("getrandom failed");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        u32::from_be_bytes(bytes[0..4].try_into().unwrap()),
        u16::from_be_bytes(bytes[4..6].try_into().unwrap()),
        u16::from_be_bytes(bytes[6..8].try_into().unwrap()),
        u16::from_be_bytes(bytes[8..10].try_into().unwrap()),
        {
            let mut v = 0u64;
            for b in &bytes[10..16] {
                v = (v << 8) | (*b as u64);
            }
            v
        }
    )
}
