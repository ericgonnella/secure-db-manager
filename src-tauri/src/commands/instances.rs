use crate::local_store::{
    append_audit_event, load_store, save_store, AuditEvent, BackupRecord, LocalInstance,
};
use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::{AppHandle, Manager};
use tokio::process::Command as TokioCommand;

// ── Secret storage (OS keyring) ────────────────────────────────────────────

pub(crate) const KEYRING_SERVICE: &str = "com.ericg.baseport";

pub(crate) fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account)
        .map_err(|e| format!("Failed to access OS keyring: {e}"))
}

pub(crate) fn store_password(account: &str, password: &str) -> Result<(), String> {
    keyring_entry(account)?
        .set_password(password)
        .map_err(|e| format!("Failed to save password to keyring: {e}"))
}

pub(crate) fn read_password(account: &str) -> Result<String, String> {
    read_password_opt(account)?.ok_or_else(|| "CREDENTIAL_NOT_FOUND".to_string())
}

/// Returns `None` when no credential is stored, `Err` only on real keyring failures.
pub(crate) fn read_password_opt(account: &str) -> Result<Option<String>, String> {
    match keyring_entry(account)?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to read password from keyring: {e}")),
    }
}

pub(crate) fn forget_password(account: &str) {
    if let Ok(entry) = keyring_entry(account) {
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
            data_path: "/pb_data",
            env_args: vec![],
            cmd_args: vec![],
            requires_db_name: false,
            requires_username: true,  // admin email
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

/// Poll `127.0.0.1:<port>` via TCP until it accepts a connection or `max_secs` elapses.
/// Returns `true` if the port became reachable, `false` on timeout.
async fn wait_for_port(port: u16, max_secs: u64) -> bool {
    use tokio::net::TcpStream;
    use tokio::time::{sleep, Duration};
    let addr = format!("127.0.0.1:{port}");
    for _ in 0..max_secs {
        sleep(Duration::from_secs(1)).await;
        if TcpStream::connect(&addr).await.is_ok() {
            // Extra buffer so PocketBase finishes its internal init before we exec into it
            sleep(Duration::from_secs(2)).await;
            return true;
        }
    }
    false
}

/// Build the docker command args prefix (handles native vs WSL2 mode).
fn docker_args_prefix(app: &AppHandle) -> (String, Vec<String>) {
    let state = app.state::<crate::AppState>();
    let mode = state.docker_mode.lock().unwrap().clone();
    match mode {
        crate::commands::docker::DockerMode::Wsl2 => {
            ("wsl".into(), vec!["docker".into()])
        }
        _ => ("docker".into(), vec![]),
    }
}

/// Run `docker exec <container> /usr/local/bin/pocketbase <sub_cmd> upsert <email> <password> --dir=/pb_data`
/// using tokio's non-blocking process API, retrying up to `max_attempts` times
/// with `delay_secs` between each try.
/// Returns `Ok(())` on success, `Err(message)` with the last stderr after exhausting retries.
async fn pb_superuser_upsert(
    app: &AppHandle,
    container: &str,
    sub_cmd: &str,
    email: &str,
    password: &str,
    max_attempts: u32,
    delay_secs: u64,
) -> Result<(), String> {
    use tokio::time::{sleep, Duration};
    let (prog, mut prefix) = docker_args_prefix(app);
    prefix.extend(["exec".into(), container.to_string(),
                   "/usr/local/bin/pocketbase".into(), sub_cmd.into(),
                   "upsert".into(), email.to_string(), password.to_string(),
                   "--dir=/pb_data".into()]);
    let mut last_err = String::from("no attempts made");
    for attempt in 1..=max_attempts {
        let out = TokioCommand::new(&prog)
            .args(&prefix)
            .output()
            .await
            .map_err(|e| format!("docker exec failed to launch: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        last_err = if stderr.is_empty() { stdout } else { stderr };
        if attempt < max_attempts {
            sleep(Duration::from_secs(delay_secs)).await;
        }
    }
    Err(last_err)
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
    if input.service_type == "pocketbase" {
        if input.password.len() < 10 {
            return Err("PocketBase superuser password must be at least 10 characters.".into());
        }
    } else if input.password.len() < 8 {
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
    if input.service_type == "pocketbase" {
        // Username is the admin email — validate format and safe characters
        let email = &username;
        if !email.contains('@') || !email.contains('.') {
            return Err("PocketBase admin must be a valid email address.".into());
        }
        if !email.chars().all(|c| c.is_alphanumeric() || "@._-+".contains(c)) {
            return Err("Admin email contains invalid characters.".into());
        }
    } else if cfg.requires_username && !safe_ident(&username) {
        return Err("Username may contain only letters, numbers, and underscores.".into());
    }

    let slug = slugify(&input.name);
    if slug.is_empty() {
        return Err("Instance name must contain at least one alphanumeric character.".into());
    }

    let container_name = format!("bp_{}_{}", slug, input.service_type);
    let volume_name = format!("bp_{}_{}_data", slug, input.service_type);
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

    // ── PocketBase: create superuser via CLI ──────────────────────────────────
    // PocketBase v0.23+ removed the web setup screen; the only supported way to
    // create the first superuser is:
    //   pocketbase superuser upsert <email> <password>   (v0.23+)
    //   pocketbase admin upsert <email> <password>       (v0.22)
    // We retry up to 10 times (3 s apart) so transient startup delays are handled.
    // If it still fails we roll back the container + volume + store entry and
    // surface the real error to the user.
    if input.service_type == "pocketbase" {
        let email = &instance.username;
        let pw = &input.password;
        let sub_cmd = if input.version.starts_with("0.22") { "admin" } else { "superuser" };

        // Give PocketBase a moment to initialise its data directory before the
        // first attempt — 5 s covers first-boot DB creation on slow machines.
        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

        if let Err(exec_err) = pb_superuser_upsert(
            &app, &container_name, sub_cmd, email, pw,
            10, 3,
        ).await {
            // Roll back: remove container + volume, remove from store.
            docker_cmd(&app)
                .args(["rm", "-f", &container_name])
                .output()
                .ok();
            docker_cmd(&app)
                .args(["volume", "rm", &volume_name])
                .output()
                .ok();
            let mut store = load_store(&app);
            store.instances.retain(|i| i.id != instance.id);
            save_store(&app, &store)?;
            forget_password(&instance.id);

            append_audit_event(&app, AuditEvent {
                id: uuid_v4(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                action: "pocketbase.superuser".into(),
                instance_id: instance.id.clone(),
                instance_name: instance.name.clone(),
                service_type: "pocketbase".into(),
                environment: instance.environment.clone(),
                outcome: "error".into(),
                detail: Some(exec_err.clone()),
            });

            return Err(format!(
                "Container started but superuser creation failed (rolled back). \
                 Error from PocketBase: {exec_err}. \
                 If the image is still pulling, wait a moment and try again."
            ));
        }
    }

    // Persist password into OS keyring (Windows Credential Manager / macOS
    // Keychain / Linux Secret Service). If this fails, the container is
    // already running and the user has the password in the wizard; surface a
    // warning via audit log but don't fail the whole command.
    let secret_outcome = match store_password(&instance.id, &input.password) {
        Ok(()) => None,
        Err(e) => Some(format!("Container started, but password could not be saved to keyring: {e}")),
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

/// Exposed command: (re-)create the PocketBase superuser for an existing instance.
/// Useful when the initial setup failed or when the admin password needs resetting.
#[tauri::command]
pub async fn setup_pocketbase_superuser(
    app: AppHandle,
    instance_id: String,
    email: String,
    password: String,
) -> Result<(), String> {
    // Validate inputs
    if !email.contains('@') || !email.contains('.') {
        return Err("Admin email must be a valid email address.".into());
    }
    if !email.chars().all(|c| c.is_alphanumeric() || "@._-+".contains(c)) {
        return Err("Admin email contains invalid characters.".into());
    }
    if password.len() < 10 {
        return Err("PocketBase admin password must be at least 10 characters.".into());
    }

    let store = load_store(&app);
    let instance = store
        .instances
        .iter()
        .find(|i| i.id == instance_id)
        .ok_or("Instance not found.")?
        .clone();

    if instance.service_type != "pocketbase" {
        return Err("This command only applies to PocketBase instances.".into());
    }

    let sub_cmd = if instance.service_type == "pocketbase" {
        // Infer from container name / stored version not tracked — default to v0.23+ command.
        "superuser"
    } else {
        "admin"
    };

    pb_superuser_upsert(&app, &instance.container_name, sub_cmd, &email, &password, 5, 3).await
        .map_err(|e| format!("Superuser upsert failed: {e}"))?;

    // Update stored username + keyring to match new credentials
    let mut store = load_store(&app);
    if let Some(inst) = store.instances.iter_mut().find(|i| i.id == instance_id) {
        inst.username = email.clone();
    }
    save_store(&app, &store)?;
    store_password(&instance_id, &password)?;

    append_audit_event(&app, AuditEvent {
        id: uuid_v4(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        action: "pocketbase.superuser".into(),
        instance_id: instance.id.clone(),
        instance_name: instance.name.clone(),
        service_type: "pocketbase".into(),
        environment: instance.environment.clone(),
        outcome: "success".into(),
        detail: Some(format!("Superuser set to {email}")),
    });

    Ok(())
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

    // Auto-reprovision any cloudflare tunnels that were paused when this instance was stopped.
    crate::commands::exposure::reprovision_cloudflare_exposures_inner(&app, &instance_id).await;

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

    // Tear down any active exposures for this instance (stop nginx/socat/cloudflared/ngrok
    // processes and delete their firewall rules). Best-effort — run after the audit event.
    crate::commands::exposure::teardown_exposures_for_instance(&app, &instance.id).await;

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

    // Tear down any active exposures before removing the container so that nginx
    // containers/socat sidecars can disconnect from the Docker network cleanly.
    crate::commands::exposure::teardown_exposures_for_instance(&app, &instance.id).await;

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

pub(crate) fn uuid_v4() -> String {
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
