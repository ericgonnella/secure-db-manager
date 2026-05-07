use crate::local_store::{
    append_audit_event, load_store, save_store, AuditEvent, BackupRecord, LocalInstance,
};
use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::{AppHandle, Manager};

// ── Secret storage (OS keyring) ────────────────────────────────────────────

const KEYRING_SERVICE: &str = "com.ericg.secure-db-manager";

fn keyring_entry(instance_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, instance_id)
        .map_err(|e| format!("Failed to access OS keyring: {e}"))
}

fn store_password(instance_id: &str, password: &str) -> Result<(), String> {
    keyring_entry(instance_id)?
        .set_password(password)
        .map_err(|e| format!("Failed to save password to keyring: {e}"))
}

fn read_password(instance_id: &str) -> Result<String, String> {
    read_password_opt(instance_id)?.ok_or_else(|| "CREDENTIAL_NOT_FOUND".to_string())
}

/// Returns `None` when no credential is stored, `Err` only on real keyring failures.
fn read_password_opt(instance_id: &str) -> Result<Option<String>, String> {
    match keyring_entry(instance_id)?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to read password from keyring: {e}")),
    }
}

fn forget_password(instance_id: &str) {
    if let Ok(entry) = keyring_entry(instance_id) {
        // Best-effort delete; ignore errors (entry may not exist)
        let _ = entry.delete_credential();
    }
}

/// Build the connection URI for a service from its stored fields + password.
fn build_connection_uri(instance: &LocalInstance, password: &str) -> String {
    let host = &instance.host;
    let port = instance.port;
    let db = instance.db_name.clone().unwrap_or_default();
    let user = &instance.username;
    match instance.service_type.as_str() {
        "postgres"   => format!("postgresql://{user}:{password}@{host}:{port}/{db}"),
        "mysql"      => format!("mysql://{user}:{password}@{host}:{port}/{db}"),
        "mariadb"    => format!("mysql://{user}:{password}@{host}:{port}/{db}"),
        "redis"      => format!("redis://:{password}@{host}:{port}/0"),
        "mongodb"    => format!("mongodb://{user}:{password}@{host}:{port}/{db}"),
        "clickhouse" => format!("clickhouse://{user}:{password}@{host}:{port}/{db}"),
        "pocketbase" => format!("http://{host}:{port}"),
        _            => format!("{host}:{port}"),
    }
}

// ── Input types ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateInstanceInput {
    pub service_type: String,
    pub name: String,
    pub version: String,
    pub port: u16,
    pub db_name: Option<String>,
    pub username: Option<String>,
    pub password: String,
    pub environment: String,
    #[serde(default = "default_project_id")]
    pub project_id: String,
}

fn default_project_id() -> String {
    "default".to_string()
}

// ── Service catalog ────────────────────────────────────────────────────────

/// Per-service docker run configuration.
struct ServiceConfig {
    /// Docker image including version, e.g. "postgres:17-alpine"
    image: String,
    /// Port the service listens on inside the container
    container_port: u16,
    /// Path mounted as the data volume inside the container
    data_path: &'static str,
    /// Static `docker run` env-var args (already built)
    env_args: Vec<String>,
    /// Trailing args after the image (e.g. for redis: `redis-server --requirepass ...`)
    cmd_args: Vec<String>,
    /// Whether the service requires a `db_name` field
    requires_db_name: bool,
    /// Whether the service requires a `username` field
    requires_username: bool,
}

/// Build a `ServiceConfig` for a given service+version, validating against an allowlist.
/// Returns Err if the service or version is not supported.
fn service_config(input: &CreateInstanceInput) -> Result<ServiceConfig, String> {
    // Validate version against per-service allowlist (prevents image injection)
    let allowed_versions: &[&str] = match input.service_type.as_str() {
        "postgres"   => &["17", "16", "15", "14"],
        "mysql"      => &["9.0", "8.4", "8.0"],
        "mariadb"    => &["11.4", "10.11", "10.6"],
        "redis"      => &["7.4", "7.2", "6.2"],
        "mongodb"    => &["8.0", "7.0", "6.0"],
        "clickhouse"  => &["24.12", "24.8", "23.8"],
        "pocketbase"  => &["0.24", "0.23", "0.22"],
        other         => return Err(format!("Unsupported service type: {other}")),
    };
    if !allowed_versions.contains(&input.version.as_str()) {
        return Err(format!(
            "Unsupported {} version: {}. Allowed: {}",
            input.service_type,
            input.version,
            allowed_versions.join(", ")
        ));
    }

    let v = &input.version;
    let pw = &input.password;
    let db = input.db_name.clone().unwrap_or_default();
    let user = input.username.clone().unwrap_or_default();

    let cfg = match input.service_type.as_str() {
        "postgres" => ServiceConfig {
            image: format!("postgres:{v}-alpine"),
            container_port: 5432,
            data_path: "/var/lib/postgresql/data",
            env_args: vec![
                "-e".into(), format!("POSTGRES_DB={db}"),
                "-e".into(), format!("POSTGRES_USER={user}"),
                "-e".into(), format!("POSTGRES_PASSWORD={pw}"),
            ],
            cmd_args: vec![],
            requires_db_name: true,
            requires_username: true,
        },
        "mysql" => ServiceConfig {
            image: format!("mysql:{v}"),
            container_port: 3306,
            data_path: "/var/lib/mysql",
            env_args: vec![
                "-e".into(), format!("MYSQL_DATABASE={db}"),
                "-e".into(), format!("MYSQL_USER={user}"),
                "-e".into(), format!("MYSQL_PASSWORD={pw}"),
                "-e".into(), format!("MYSQL_ROOT_PASSWORD={pw}"),
            ],
            cmd_args: vec![],
            requires_db_name: true,
            requires_username: true,
        },
        "mariadb" => ServiceConfig {
            image: format!("mariadb:{v}"),
            container_port: 3306,
            data_path: "/var/lib/mysql",
            env_args: vec![
                "-e".into(), format!("MARIADB_DATABASE={db}"),
                "-e".into(), format!("MARIADB_USER={user}"),
                "-e".into(), format!("MARIADB_PASSWORD={pw}"),
                "-e".into(), format!("MARIADB_ROOT_PASSWORD={pw}"),
            ],
            cmd_args: vec![],
            requires_db_name: true,
            requires_username: true,
        },
        "redis" => ServiceConfig {
            image: format!("redis:{v}-alpine"),
            container_port: 6379,
            data_path: "/data",
            env_args: vec![],
            cmd_args: vec![
                "redis-server".into(),
                "--requirepass".into(),
                pw.clone(),
                "--appendonly".into(),
                "yes".into(),
            ],
            requires_db_name: false,
            requires_username: false,
        },
        "mongodb" => ServiceConfig {
            image: format!("mongo:{v}"),
            container_port: 27017,
            data_path: "/data/db",
            env_args: vec![
                "-e".into(), format!("MONGO_INITDB_ROOT_USERNAME={user}"),
                "-e".into(), format!("MONGO_INITDB_ROOT_PASSWORD={pw}"),
                "-e".into(), format!("MONGO_INITDB_DATABASE={db}"),
            ],
            cmd_args: vec![],
            requires_db_name: true,
            requires_username: true,
        },
        "clickhouse" => ServiceConfig {
            image: format!("clickhouse/clickhouse-server:{v}"),
            container_port: 8123,
            data_path: "/var/lib/clickhouse",
            env_args: vec![
                "-e".into(), format!("CLICKHOUSE_DB={db}"),
                "-e".into(), format!("CLICKHOUSE_USER={user}"),
                "-e".into(), format!("CLICKHOUSE_PASSWORD={pw}"),
                "-e".into(), "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1".into(),
            ],
            cmd_args: vec![],
            requires_db_name: true,
            requires_username: true,
        },
        "pocketbase" => ServiceConfig {
            image: format!("ghcr.io/muchobien/pocketbase:{v}"),
            container_port: 8090,
            data_path: "/pb/pb_data",
            env_args: vec![],
            cmd_args: vec![],
            requires_db_name: false,
            requires_username: false,
        },
        _ => unreachable!(), // already validated above
    };
    Ok(cfg)
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
pub async fn create_local_instance(
    app: AppHandle,
    input: CreateInstanceInput,
) -> Result<LocalInstance, String> {
    // ── Validate inputs ────────────────────────────────────────────────────
    if input.name.trim().is_empty() {
        return Err("Instance name is required.".into());
    }
    if input.service_type != "pocketbase" && input.password.len() < 8 {
        return Err("Password must be at least 8 characters.".into());
    }
    if input.port < 1024 {
        return Err("Port must be 1024 or higher.".into());
    }

    // Resolve service-specific config (also validates service_type + version)
    let cfg = service_config(&input)?;

    // Per-service required-field checks
    let db_name = if cfg.requires_db_name {
        let v = input.db_name.clone().unwrap_or_default();
        if v.trim().is_empty() {
            return Err("Database name is required.".into());
        }
        Some(v)
    } else {
        None
    };
    let username = if cfg.requires_username {
        let v = input.username.clone().unwrap_or_default();
        if v.trim().is_empty() {
            return Err("Username is required.".into());
        }
        v
    } else {
        // Use a default placeholder for services without auth users (e.g. redis)
        "default".into()
    };

    // Validate identifiers (db_name + username) — only safe characters allowed
    let safe_ident = |s: &str| s.chars().all(|c| c.is_alphanumeric() || c == '_');
    if let Some(d) = &db_name {
        if !safe_ident(d) {
            return Err("Database name may contain only letters, numbers, and underscores.".into());
        }
    }
    if cfg.requires_username && !safe_ident(&username) {
        return Err("Username may contain only letters, numbers, and underscores.".into());
    }

    let slug = slugify(&input.name);
    if slug.is_empty() {
        return Err("Instance name must contain at least one alphanumeric character.".into());
    }

    let container_name = format!("sdm_{}_{}", slug, input.service_type);
    let volume_name = format!("sdm_{}_{}_data", slug, input.service_type);
    let port_bind = format!("127.0.0.1:{}:{}", input.port, cfg.container_port);

    // ── Create the volume ──────────────────────────────────────────────────
    let vol_out = docker_cmd(&app)
        .args(["volume", "create", &volume_name])
        .output()
        .map_err(|e| format!("Failed to run docker: {e}"))?;

    if !vol_out.status.success() {
        let err = String::from_utf8_lossy(&vol_out.stderr);
        return Err(format!("Failed to create volume: {err}"));
    }

    // ── Build & run the container ──────────────────────────────────────────
    let mut args: Vec<String> = vec![
        "run".into(), "-d".into(),
        "--name".into(), container_name.clone(),
        "--restart".into(), "unless-stopped".into(),
    ];
    args.extend(cfg.env_args.iter().cloned());
    args.push("-p".into());
    args.push(port_bind.clone());
    args.push("-v".into());
    args.push(format!("{}:{}", volume_name, cfg.data_path));
    args.push("--label".into());
    args.push(format!("app.securedbmanager.service_type={}", input.service_type));
    args.push("--label".into());
    args.push(format!("app.securedbmanager.environment={}", input.environment));
    args.push(cfg.image.clone());
    args.extend(cfg.cmd_args.iter().cloned());

    let run_out = docker_cmd(&app)
        .args(&args)
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
        service_type: input.service_type.clone(),
        environment: input.environment.clone(),
        container_name: container_name.clone(),
        volume_name: volume_name.clone(),
        host: "127.0.0.1".into(),
        port: input.port,
        db_name,
        username,
        status: "running".into(),
        created_at: now,
        project_id: input.project_id.clone(),
    };

    // Persist to local store
    let mut store = load_store(&app);
    store.instances.push(instance.clone());
    save_store(&app, &store)?;

    // Persist password into OS keyring (Windows Credential Manager / macOS
    // Keychain / Linux Secret Service). If this fails, the container is
    // already running and the user has the password in the wizard; surface a
    // warning via audit log but don't fail the whole command.
    // PocketBase has no password — skip keyring storage.
    let secret_outcome = if input.service_type == "pocketbase" {
        None
    } else {
        match store_password(&instance.id, &input.password) {
            Ok(()) => None,
            Err(e) => Some(format!("Container started, but password could not be saved to keyring: {e}")),
        }
    };

    append_audit_event(&app, AuditEvent {
        id: uuid_v4(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        action: "instance.create".into(),
        instance_id: instance.id.clone(),
        instance_name: instance.name.clone(),
        service_type: instance.service_type.clone(),
        environment: instance.environment.clone(),
        outcome: "success".into(),
        detail: Some(format!("Container {} started on port {}", container_name, input.port)),
    });

    if let Some(warn) = secret_outcome {
        append_audit_event(&app, AuditEvent {
            id: uuid_v4(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "credentials.store".into(),
            instance_id: instance.id.clone(),
            instance_name: instance.name.clone(),
            service_type: instance.service_type.clone(),
            environment: instance.environment.clone(),
            outcome: "error".into(),
            detail: Some(warn),
        });
    }

    Ok(instance)
}

#[tauri::command]
pub async fn list_local_instances(app: AppHandle) -> Result<Vec<LocalInstance>, String> {
    let store = load_store(&app);
    Ok(store.instances)
}

#[tauri::command]
pub async fn list_audit_logs(app: AppHandle) -> Result<Vec<crate::local_store::AuditEvent>, String> {
    let store = load_store(&app);
    let mut events = store.audit_log;
    events.reverse(); // newest first
    Ok(events)
}

#[tauri::command]
pub async fn start_local_instance(
    app: AppHandle,
    instance_id: String,
) -> Result<(), String> {
    let mut store = load_store(&app);
    let pos = store
        .instances
        .iter()
        .position(|i| i.id == instance_id)
        .ok_or("Instance not found.")?;
    let instance = store.instances[pos].clone();

    let out = docker_cmd(&app)
        .args(["start", &instance.container_name])
        .output()
        .map_err(|e| format!("Failed to run docker: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        append_audit_event(&app, AuditEvent {
            id: uuid_v4(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "instance.start".into(),
            instance_id: instance.id.clone(),
            instance_name: instance.name.clone(),
            service_type: instance.service_type.clone(),
            environment: instance.environment.clone(),
            outcome: "error".into(),
            detail: Some(err.clone()),
        });
        return Err(format!("Failed to start container: {err}"));
    }

    store.instances[pos].status = "running".into();
    save_store(&app, &store)?;

    append_audit_event(&app, AuditEvent {
        id: uuid_v4(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        action: "instance.start".into(),
        instance_id: instance.id.clone(),
        instance_name: instance.name.clone(),
        service_type: instance.service_type.clone(),
        environment: instance.environment.clone(),
        outcome: "success".into(),
        detail: None,
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_local_instance(
    app: AppHandle,
    instance_id: String,
) -> Result<(), String> {
    let mut store = load_store(&app);
    let pos = store
        .instances
        .iter()
        .position(|i| i.id == instance_id)
        .ok_or("Instance not found.")?;
    let instance = store.instances[pos].clone();

    let out = docker_cmd(&app)
        .args(["stop", &instance.container_name])
        .output()
        .map_err(|e| format!("Failed to run docker: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        append_audit_event(&app, AuditEvent {
            id: uuid_v4(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "instance.stop".into(),
            instance_id: instance.id.clone(),
            instance_name: instance.name.clone(),
            service_type: instance.service_type.clone(),
            environment: instance.environment.clone(),
            outcome: "error".into(),
            detail: Some(err.clone()),
        });
        return Err(format!("Failed to stop container: {err}"));
    }

    store.instances[pos].status = "stopped".into();
    save_store(&app, &store)?;

    append_audit_event(&app, AuditEvent {
        id: uuid_v4(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        action: "instance.stop".into(),
        instance_id: instance.id.clone(),
        instance_name: instance.name.clone(),
        service_type: instance.service_type.clone(),
        environment: instance.environment.clone(),
        outcome: "success".into(),
        detail: None,
    });
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

    // Remove the password from the OS keyring (best effort)
    forget_password(&instance.id);

    append_audit_event(&app, AuditEvent {
        id: uuid_v4(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        action: "instance.delete".into(),
        instance_id: instance.id.clone(),
        instance_name: instance.name.clone(),
        service_type: instance.service_type.clone(),
        environment: instance.environment.clone(),
        outcome: "success".into(),
        detail: if delete_volume { Some("Volume deleted".into()) } else { None },
    });
    Ok(())
}

// ── Credentials ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct InstanceCredentials {
    pub instance_id: String,
    pub host: String,
    pub port: u16,
    pub db_name: Option<String>,
    pub username: String,
    pub password: String,
    pub connection_uri: String,
}

#[tauri::command]
pub async fn get_instance_credentials(
    app: AppHandle,
    instance_id: String,
) -> Result<InstanceCredentials, String> {
    let store = load_store(&app);
    let instance = store
        .instances
        .iter()
        .find(|i| i.id == instance_id)
        .ok_or("Instance not found.")?
        .clone();

    let password = match read_password_opt(&instance.id)? {
        Some(pw) => pw,
        None if instance.service_type == "pocketbase" => String::new(),
        None => return Err("CREDENTIAL_NOT_FOUND".to_string()),
    };
    let connection_uri = build_connection_uri(&instance, &password);

    append_audit_event(&app, AuditEvent {
        id: uuid_v4(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        action: "credentials.reveal".into(),
        instance_id: instance.id.clone(),
        instance_name: instance.name.clone(),
        service_type: instance.service_type.clone(),
        environment: instance.environment.clone(),
        outcome: "success".into(),
        detail: None,
    });

    Ok(InstanceCredentials {
        instance_id: instance.id.clone(),
        host: instance.host.clone(),
        port: instance.port,
        db_name: instance.db_name.clone(),
        username: instance.username.clone(),
        password,
        connection_uri,
    })
}

/// Store (or update) the password for an existing instance in the OS keyring.
/// Used when a user manually enters the password for an instance created before
/// credential storage was added.
#[tauri::command]
pub async fn set_instance_password(
    app: AppHandle,
    instance_id: String,
    password: String,
) -> Result<(), String> {
    if password.len() < 8 {
        return Err("Password must be at least 8 characters.".into());
    }
    let store = load_store(&app);
    let instance = store
        .instances
        .iter()
        .find(|i| i.id == instance_id)
        .ok_or("Instance not found.")?
        .clone();

    store_password(&instance.id, &password)?;

    append_audit_event(
        &app,
        AuditEvent {
            id: uuid_v4(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "credentials.update".into(),
            instance_id: instance.id.clone(),
            instance_name: instance.name.clone(),
            service_type: instance.service_type.clone(),
            environment: instance.environment.clone(),
            outcome: "success".into(),
            detail: Some("Password updated via UI".into()),
        },
    );

    Ok(())
}

// ── Container logs ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_container_logs(
    app: AppHandle,
    instance_id: String,
    tail: Option<u32>,
) -> Result<String, String> {
    let store = load_store(&app);
    let instance = store
        .instances
        .iter()
        .find(|i| i.id == instance_id)
        .ok_or("Instance not found.")?
        .clone();

    // Cap tail to a sane upper bound to avoid pulling unbounded logs
    let tail_n = tail.unwrap_or(200).min(5000);
    let tail_arg = tail_n.to_string();

    let out = docker_cmd(&app)
        .args(["logs", "--tail", &tail_arg, &instance.container_name])
        .output()
        .map_err(|e| format!("Failed to run docker: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(format!("Failed to fetch logs: {err}"));
    }

    // docker writes container stdout to our stdout and stderr to our stderr
    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&out.stdout));
    let stderr_str = String::from_utf8_lossy(&out.stderr);
    if !stderr_str.is_empty() {
        combined.push_str(&stderr_str);
    }
    Ok(combined)
}

// ── Connection test / health probe ────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ConnectionTestResult {
    pub healthy: bool,
    pub latency_ms: u64,
    pub message: String,
}

#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    instance_id: String,
) -> Result<ConnectionTestResult, String> {
    let store = load_store(&app);
    let instance = store
        .instances
        .iter()
        .find(|i| i.id == instance_id)
        .ok_or("Instance not found.")?
        .clone();

    let password = read_password(&instance.id).unwrap_or_default();

    // Build a per-service in-container probe using `docker exec`.
    // We pass any password via env var to avoid leaking it through process args.
    let (probe_cmd, env_var, env_val): (Vec<String>, Option<&str>, Option<String>) =
        match instance.service_type.as_str() {
            "postgres" => (
                vec![
                    "pg_isready".into(),
                    "-U".into(),
                    instance.username.clone(),
                    "-d".into(),
                    instance.db_name.clone().unwrap_or_else(|| "postgres".into()),
                ],
                None,
                None,
            ),
            "mysql" | "mariadb" => (
                vec![
                    "sh".into(),
                    "-c".into(),
                    format!(
                        "mysqladmin ping -u{} -p\"$MYSQL_PWD\" --silent",
                        shell_escape(&instance.username)
                    ),
                ],
                Some("MYSQL_PWD"),
                Some(password.clone()),
            ),
            "redis" => {
                let cmd = if password.is_empty() {
                    vec!["redis-cli".into(), "PING".into()]
                } else {
                    vec![
                        "sh".into(),
                        "-c".into(),
                        "redis-cli -a \"$REDISCLI_AUTH\" --no-auth-warning PING".into(),
                    ]
                };
                (
                    cmd,
                    if password.is_empty() {
                        None
                    } else {
                        Some("REDISCLI_AUTH")
                    },
                    if password.is_empty() {
                        None
                    } else {
                        Some(password.clone())
                    },
                )
            }
            "mongo" | "mongodb" => (
                vec![
                    "sh".into(),
                    "-c".into(),
                    format!(
                        "mongosh --quiet -u {} -p \"$MONGO_PWD\" --authenticationDatabase admin --eval 'db.runCommand({{ ping: 1 }}).ok'",
                        shell_escape(&instance.username)
                    ),
                ],
                Some("MONGO_PWD"),
                Some(password.clone()),
            ),
            "clickhouse" => (
                vec![
                    "sh".into(),
                    "-c".into(),
                    format!(
                        "clickhouse-client --user {} --password \"$CLICKHOUSE_PWD\" --query 'SELECT 1'",
                        shell_escape(&instance.username)
                    ),
                ],
                Some("CLICKHOUSE_PWD"),
                Some(password.clone()),
            ),
            "pocketbase" => (
                vec![
                    "sh".into(),
                    "-c".into(),
                    "wget -T3 -qO /dev/null http://127.0.0.1:8090/api/health && echo OK".into(),
                ],
                None,
                None,
            ),
            other => {
                return Err(format!("Health check not implemented for {other}"));
            }
        };

    let start = std::time::Instant::now();

    let mut cmd = docker_cmd(&app);
    cmd.arg("exec");
    if let (Some(name), Some(val)) = (env_var, env_val.as_ref()) {
        cmd.args(["-e", &format!("{name}={val}")]);
    }
    cmd.arg(&instance.container_name);
    for a in &probe_cmd {
        cmd.arg(a);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("Failed to run docker exec: {e}"))?;

    let latency_ms = start.elapsed().as_millis() as u64;

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let healthy = out.status.success();
    let message = if healthy {
        if stdout.is_empty() {
            "OK".to_string()
        } else {
            stdout
        }
    } else if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("exit code {}", out.status.code().unwrap_or(-1))
    };

    append_audit_event(
        &app,
        AuditEvent {
            id: uuid_v4(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "connection.test".into(),
            instance_id: instance.id.clone(),
            instance_name: instance.name.clone(),
            service_type: instance.service_type.clone(),
            environment: instance.environment.clone(),
            outcome: if healthy {
                "success".into()
            } else {
                "error".into()
            },
            detail: Some(format!("latency_ms={latency_ms}; {message}")),
        },
    );

    Ok(ConnectionTestResult {
        healthy,
        latency_ms,
        message,
    })
}

// Minimal shell-escape: wraps the value in single quotes and escapes embedded ones.
// Used only for usernames/db names that we already validate, but defense-in-depth.
fn shell_escape(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        s.to_string()
    } else {
        let escaped = s.replace('\'', "'\\''");
        format!("'{}'", escaped)
    }
}

// ── Backup & restore ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct BackupInput {
    pub instance_id: String,
    /// Absolute directory the backup file should be written to.
    pub destination_dir: String,
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RestoreInput {
    pub instance_id: String,
    /// Absolute path to the .tar.gz backup file.
    pub source_file: String,
}

fn validate_abs_path(p: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(p);
    if !path.is_absolute() {
        return Err("Path must be absolute.".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn backup_instance(
    app: AppHandle,
    input: BackupInput,
) -> Result<BackupRecord, String> {
    let store = load_store(&app);
    let instance = store
        .instances
        .iter()
        .find(|i| i.id == input.instance_id)
        .ok_or("Instance not found.")?
        .clone();

    let dest_dir = validate_abs_path(&input.destination_dir)?;
    if !dest_dir.exists() || !dest_dir.is_dir() {
        return Err("Destination directory does not exist.".into());
    }

    // Build a safe filename
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let safe_name: String = instance
        .name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let filename = format!("{}-{}-{}.tar.gz", safe_name, instance.service_type, ts);
    let dest_file = dest_dir.join(&filename);

    let dest_dir_str = dest_dir
        .to_str()
        .ok_or("Destination path is not valid UTF-8.")?;

    // Run a throwaway alpine container to tar the volume contents
    let out = docker_cmd(&app)
        .args([
            "run",
            "--rm",
            "-v",
            &format!("{}:/source:ro", instance.volume_name),
            "-v",
            &format!("{}:/backup", dest_dir_str),
            "alpine",
            "sh",
            "-c",
            &format!(
                "cd /source && tar czf /backup/{} .",
                shell_escape(&filename)
            ),
        ])
        .output()
        .map_err(|e| format!("Failed to run docker: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        append_audit_event(
            &app,
            AuditEvent {
                id: uuid_v4(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                action: "backup.create".into(),
                instance_id: instance.id.clone(),
                instance_name: instance.name.clone(),
                service_type: instance.service_type.clone(),
                environment: instance.environment.clone(),
                outcome: "error".into(),
                detail: Some(err.clone()),
            },
        );
        return Err(format!("Backup failed: {err}"));
    }

    let size_bytes = std::fs::metadata(&dest_file)
        .map(|m| m.len())
        .unwrap_or(0);

    let record = BackupRecord {
        id: uuid_v4(),
        instance_id: instance.id.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        file_path: dest_file.to_string_lossy().to_string(),
        size_bytes,
        note: input.note.clone(),
    };

    let mut store = load_store(&app);
    store.backups.push(record.clone());
    save_store(&app, &store)?;

    append_audit_event(
        &app,
        AuditEvent {
            id: uuid_v4(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "backup.create".into(),
            instance_id: instance.id.clone(),
            instance_name: instance.name.clone(),
            service_type: instance.service_type.clone(),
            environment: instance.environment.clone(),
            outcome: "success".into(),
            detail: Some(format!(
                "file={}; size={}",
                record.file_path, record.size_bytes
            )),
        },
    );

    Ok(record)
}

#[tauri::command]
pub async fn restore_instance(
    app: AppHandle,
    input: RestoreInput,
) -> Result<(), String> {
    let store = load_store(&app);
    let instance = store
        .instances
        .iter()
        .find(|i| i.id == input.instance_id)
        .ok_or("Instance not found.")?
        .clone();

    let src_file = validate_abs_path(&input.source_file)?;
    if !src_file.exists() || !src_file.is_file() {
        return Err("Backup file not found.".into());
    }
    let src_dir = src_file
        .parent()
        .ok_or("Cannot resolve backup directory.")?;
    let filename = src_file
        .file_name()
        .ok_or("Invalid backup filename.")?
        .to_string_lossy()
        .to_string();
    let src_dir_str = src_dir
        .to_str()
        .ok_or("Backup path is not valid UTF-8.")?;

    // Stop the container before restoring (best effort)
    let _ = docker_cmd(&app)
        .args(["stop", &instance.container_name])
        .output();

    let out = docker_cmd(&app)
        .args([
            "run",
            "--rm",
            "-v",
            &format!("{}:/target", instance.volume_name),
            "-v",
            &format!("{}:/backup:ro", src_dir_str),
            "alpine",
            "sh",
            "-c",
            // Wipe target then untar; using --strip-components keeps us flexible if archive has a leading dir
            &format!(
                "cd /target && find . -mindepth 1 -delete && tar xzf /backup/{}",
                shell_escape(&filename)
            ),
        ])
        .output()
        .map_err(|e| format!("Failed to run docker: {e}"))?;

    let outcome_ok = out.status.success();
    let detail = if outcome_ok {
        format!("from={}", src_file.display())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        format!("error: {err}")
    };

    append_audit_event(
        &app,
        AuditEvent {
            id: uuid_v4(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "backup.restore".into(),
            instance_id: instance.id.clone(),
            instance_name: instance.name.clone(),
            service_type: instance.service_type.clone(),
            environment: instance.environment.clone(),
            outcome: if outcome_ok { "success".into() } else { "error".into() },
            detail: Some(detail.clone()),
        },
    );

    // Try to start the container again regardless of outcome
    let _ = docker_cmd(&app)
        .args(["start", &instance.container_name])
        .output();

    if !outcome_ok {
        return Err(format!("Restore failed: {detail}"));
    }

    Ok(())
}

#[tauri::command]
pub async fn list_backups(
    app: AppHandle,
    instance_id: Option<String>,
) -> Result<Vec<BackupRecord>, String> {
    let store = load_store(&app);
    let mut items: Vec<BackupRecord> = match instance_id {
        Some(id) => store
            .backups
            .into_iter()
            .filter(|b| b.instance_id == id)
            .collect(),
        None => store.backups,
    };
    // newest first
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(items)
}

#[tauri::command]
pub async fn delete_backup(app: AppHandle, backup_id: String) -> Result<(), String> {
    let mut store = load_store(&app);
    let pos = store
        .backups
        .iter()
        .position(|b| b.id == backup_id)
        .ok_or("Backup not found.")?;
    let record = store.backups.remove(pos);
    save_store(&app, &store)?;
    // best-effort delete file
    let _ = std::fs::remove_file(&record.file_path);
    append_audit_event(
        &app,
        AuditEvent {
            id: uuid_v4(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "backup.delete".into(),
            instance_id: record.instance_id.clone(),
            instance_name: String::new(),
            service_type: String::new(),
            environment: String::new(),
            outcome: "success".into(),
            detail: Some(record.file_path.clone()),
        },
    );
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
