use crate::commands::instances::{
    forget_password, read_password, read_password_opt, store_password, uuid_v4,
};
use crate::local_store::{
    append_audit_event, load_store, save_store, AuditEvent, RemoteHost,
};
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::AppHandle;
use tokio::process::Command as TokioCommand;
use tokio::time::Duration;

// ── Input / output types ───────────────────────────────────────────────────

fn default_project_id() -> String {
    "default".to_string()
}

#[derive(Debug, Deserialize)]
pub struct AddRemoteHostInput {
    pub name: String,
    pub service_type: String,
    pub environment: String,
    pub host: String,
    pub port: u16,
    pub db_name: Option<String>,
    pub username: String,
    pub password: String,
    pub ssl_mode: Option<String>,     // defaults per service
    pub auth_type: Option<String>,    // "password" | "ssh-tunnel"
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_user: Option<String>,
    pub ssh_key_path: Option<String>,
    pub notes: Option<String>,
    #[serde(default = "default_project_id")]
    pub project_id: String,
}

#[derive(Debug, Serialize)]
pub struct RemoteHostCredentials {
    pub host_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub db_name: Option<String>,
    pub connection_uri: String,
}

#[derive(Debug, Serialize)]
pub struct RemoteConnectionResult {
    pub healthy: bool,
    pub latency_ms: u64,
    pub message: String,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn keyring_account(host_id: &str) -> String {
    format!("remote_{host_id}")
}

const SUPPORTED_SERVICES: &[&str] = &[
    "postgres", "mysql", "mariadb", "redis", "mongodb", "clickhouse", "pocketbase",
];

fn validate_service(s: &str) -> Result<(), String> {
    if SUPPORTED_SERVICES.contains(&s) {
        Ok(())
    } else {
        Err(format!("Unsupported service type: {s}"))
    }
}

/// Build connection URI for a remote host. Mirrors the local-instance behaviour
/// so the UI can present the same shape regardless of source.
fn build_remote_uri(host: &RemoteHost, password: &str) -> String {
    let h = &host.host;
    let p = host.port;
    let db = host.db_name.clone().unwrap_or_default();
    let u = &host.username;
    // sslmode parameter for services that understand it.
    let ssl = match host.ssl_mode.as_str() {
        "disable" | "" => "",
        m => m,
    };
    match host.service_type.as_str() {
        "postgres" => {
            if ssl.is_empty() {
                format!("postgresql://{u}:{password}@{h}:{p}/{db}")
            } else {
                format!("postgresql://{u}:{password}@{h}:{p}/{db}?sslmode={ssl}")
            }
        }
        "mysql" | "mariadb" => format!("mysql://{u}:{password}@{h}:{p}/{db}"),
        "redis" => format!("redis://:{password}@{h}:{p}/0"),
        "mongodb" => {
            let tls = if ssl.is_empty() { "" } else { "?tls=true" };
            format!("mongodb://{u}:{password}@{h}:{p}/{db}{tls}")
        }
        "clickhouse" => format!("clickhouse://{u}:{password}@{h}:{p}/{db}"),
        "pocketbase" => format!("http://{h}:{p}"),
        _ => format!("{h}:{p}"),
    }
}

/// Best-effort TCP probe (no auth). Used when full client tools aren't available.
async fn tcp_probe(host: &str, port: u16, timeout_secs: u64) -> Result<u64, String> {
    use tokio::net::TcpStream;
    use tokio::time::timeout;
    let start = Instant::now();
    let addr = format!("{host}:{port}");
    match timeout(Duration::from_secs(timeout_secs), TcpStream::connect(&addr)).await {
        Ok(Ok(_)) => Ok(start.elapsed().as_millis() as u64),
        Ok(Err(e)) => Err(format!("TCP connect failed: {e}")),
        Err(_) => Err(format!("Connection timed out after {timeout_secs}s")),
    }
}

/// Run a probe inside a throwaway docker container — only used when Docker is
/// available. We rely on the host's docker installation; this gives full
/// per-service auth checks without bundling client binaries.
async fn docker_probe(
    image: &str,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<(bool, String), String> {
    let mut cmd = TokioCommand::new("docker");
    cmd.arg("run").arg("--rm").arg("--network").arg("host");
    for (k, v) in env {
        cmd.arg("-e").arg(format!("{k}={v}"));
    }
    cmd.arg(image);
    for a in args {
        cmd.arg(a);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("docker exec failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let msg = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        String::new()
    };
    Ok((out.status.success(), msg))
}

// ── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn add_remote_host(
    app: AppHandle,
    input: AddRemoteHostInput,
) -> Result<RemoteHost, String> {
    // ── Validation ─────────────────────────────────────────────────────────
    if input.name.trim().is_empty() {
        return Err("Host name is required.".into());
    }
    validate_service(&input.service_type)?;
    if input.host.trim().is_empty() {
        return Err("Host address is required.".into());
    }
    if input.port == 0 {
        return Err("Port must be greater than 0.".into());
    }
    if input.username.trim().is_empty() && input.service_type != "redis" {
        return Err("Username is required.".into());
    }
    if input.password.is_empty() {
        return Err("Password is required.".into());
    }

    // Allowlist for host (DNS name or IP). Accept letters, digits, dots,
    // hyphens, underscores and colons (for IPv6 brackets — but reject [] to
    // keep things simple for v1).
    let host_ok = input
        .host
        .chars()
        .all(|c| c.is_alphanumeric() || ".-_:".contains(c));
    if !host_ok {
        return Err("Host contains invalid characters.".into());
    }

    let auth_type = input
        .auth_type
        .clone()
        .unwrap_or_else(|| "password".into());
    if auth_type != "password" && auth_type != "ssh-tunnel" {
        return Err("auth_type must be 'password' or 'ssh-tunnel'.".into());
    }
    if auth_type == "ssh-tunnel" {
        if input.ssh_host.as_deref().unwrap_or("").trim().is_empty() {
            return Err("SSH host is required for SSH tunnel auth.".into());
        }
        if input.ssh_user.as_deref().unwrap_or("").trim().is_empty() {
            return Err("SSH user is required for SSH tunnel auth.".into());
        }
    }

    let ssl_mode = input.ssl_mode.unwrap_or_else(|| {
        if matches!(input.service_type.as_str(), "redis" | "pocketbase") {
            "disable".into()
        } else {
            "require".into()
        }
    });
    if !["disable", "require", "verify-ca", "verify-full"].contains(&ssl_mode.as_str()) {
        return Err("ssl_mode must be one of: disable, require, verify-ca, verify-full".into());
    }

    // Reject duplicate names within the same project.
    let store = load_store(&app);
    if store
        .remote_hosts
        .iter()
        .any(|h| h.project_id == input.project_id && h.name == input.name)
    {
        return Err("A remote host with that name already exists in this project.".into());
    }

    let id = format!("remote_{}", uuid_v4());
    let now = chrono::Utc::now().to_rfc3339();

    let host = RemoteHost {
        id: id.clone(),
        name: input.name.clone(),
        service_type: input.service_type.clone(),
        environment: input.environment.clone(),
        host: input.host.clone(),
        port: input.port,
        db_name: input.db_name.clone(),
        username: input.username.clone(),
        ssl_mode,
        auth_type,
        ssh_host: input.ssh_host.clone(),
        ssh_port: input.ssh_port,
        ssh_user: input.ssh_user.clone(),
        ssh_key_path: input.ssh_key_path.clone(),
        notes: input.notes.clone(),
        created_at: now,
        project_id: input.project_id.clone(),
    };

    // Persist password to keyring before writing the metadata so we don't end
    // up with a host record referencing a missing secret.
    store_password(&keyring_account(&id), &input.password)?;

    let mut store = load_store(&app);
    store.remote_hosts.push(host.clone());
    if let Err(e) = save_store(&app, &store) {
        // Roll back keyring on store failure.
        forget_password(&keyring_account(&id));
        return Err(e);
    }

    append_audit_event(
        &app,
        AuditEvent {
            id: uuid_v4(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "remote.host.add".into(),
            instance_id: id.clone(),
            instance_name: host.name.clone(),
            service_type: host.service_type.clone(),
            environment: host.environment.clone(),
            outcome: "success".into(),
            detail: Some(format!("Saved remote host at {}:{}", host.host, host.port)),
        },
    );

    Ok(host)
}

#[tauri::command]
pub async fn list_remote_hosts(app: AppHandle) -> Result<Vec<RemoteHost>, String> {
    Ok(load_store(&app).remote_hosts)
}

#[tauri::command]
pub async fn delete_remote_host(app: AppHandle, host_id: String) -> Result<(), String> {
    let mut store = load_store(&app);
    let host = store
        .remote_hosts
        .iter()
        .find(|h| h.id == host_id)
        .cloned()
        .ok_or("Remote host not found.")?;

    store.remote_hosts.retain(|h| h.id != host_id);
    save_store(&app, &store)?;
    forget_password(&keyring_account(&host_id));

    append_audit_event(
        &app,
        AuditEvent {
            id: uuid_v4(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "remote.host.delete".into(),
            instance_id: host.id.clone(),
            instance_name: host.name.clone(),
            service_type: host.service_type.clone(),
            environment: host.environment.clone(),
            outcome: "success".into(),
            detail: None,
        },
    );

    Ok(())
}

#[tauri::command]
pub async fn get_remote_host_credentials(
    app: AppHandle,
    host_id: String,
) -> Result<RemoteHostCredentials, String> {
    let store = load_store(&app);
    let host = store
        .remote_hosts
        .iter()
        .find(|h| h.id == host_id)
        .cloned()
        .ok_or("Remote host not found.")?;

    let password = read_password(&keyring_account(&host_id))?;
    let connection_uri = build_remote_uri(&host, &password);

    append_audit_event(
        &app,
        AuditEvent {
            id: uuid_v4(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "remote.host.credentials.reveal".into(),
            instance_id: host.id.clone(),
            instance_name: host.name.clone(),
            service_type: host.service_type.clone(),
            environment: host.environment.clone(),
            outcome: "success".into(),
            detail: None,
        },
    );

    Ok(RemoteHostCredentials {
        host_id: host.id,
        host: host.host,
        port: host.port,
        username: host.username,
        password,
        db_name: host.db_name,
        connection_uri,
    })
}

#[tauri::command]
pub async fn set_remote_host_password(
    app: AppHandle,
    host_id: String,
    password: String,
) -> Result<(), String> {
    if password.is_empty() {
        return Err("Password cannot be empty.".into());
    }
    let store = load_store(&app);
    let host = store
        .remote_hosts
        .iter()
        .find(|h| h.id == host_id)
        .cloned()
        .ok_or("Remote host not found.")?;

    store_password(&keyring_account(&host_id), &password)?;

    append_audit_event(
        &app,
        AuditEvent {
            id: uuid_v4(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "remote.host.credentials.update".into(),
            instance_id: host.id,
            instance_name: host.name,
            service_type: host.service_type,
            environment: host.environment,
            outcome: "success".into(),
            detail: None,
        },
    );

    Ok(())
}

/// Test connectivity to a remote host.
///
/// Strategy: best-effort TCP probe first (always works). If Docker is
/// available, follow up with a service-specific auth probe in a throwaway
/// container. We don't bundle client binaries, so without Docker we can only
/// confirm the port is reachable.
#[tauri::command]
pub async fn test_remote_connection(
    app: AppHandle,
    host_id: String,
) -> Result<RemoteConnectionResult, String> {
    let store = load_store(&app);
    let host = store
        .remote_hosts
        .iter()
        .find(|h| h.id == host_id)
        .cloned()
        .ok_or("Remote host not found.")?;

    let start = Instant::now();

    // Step 1 — TCP reachability (always).
    if let Err(msg) = tcp_probe(&host.host, host.port, 5).await {
        let result = RemoteConnectionResult {
            healthy: false,
            latency_ms: start.elapsed().as_millis() as u64,
            message: msg,
        };
        append_audit_event(
            &app,
            AuditEvent {
                id: uuid_v4(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                action: "remote.host.test".into(),
                instance_id: host.id.clone(),
                instance_name: host.name.clone(),
                service_type: host.service_type.clone(),
                environment: host.environment.clone(),
                outcome: "error".into(),
                detail: Some(result.message.clone()),
            },
        );
        return Ok(result);
    }

    // Step 2 — try a credentialed probe if we have a password.
    let password_opt = read_password_opt(&keyring_account(&host_id))
        .ok()
        .flatten();

    let (healthy, message) = if let Some(password) = password_opt {
        match host.service_type.as_str() {
            "postgres" => {
                let port_str = host.port.to_string();
                let args: Vec<&str> = vec![
                    "psql",
                    "-h", &host.host,
                    "-p", &port_str,
                    "-U", &host.username,
                    "-d", host.db_name.as_deref().unwrap_or("postgres"),
                    "-c", "SELECT 1",
                    "-t",
                ];
                match docker_probe(
                    "postgres:17-alpine",
                    &args,
                    &[("PGPASSWORD", &password)],
                )
                .await
                {
                    Ok((true, _)) => (true, "PostgreSQL authentication succeeded.".into()),
                    Ok((false, msg)) => (false, format!("PostgreSQL probe failed: {msg}")),
                    Err(e) => (true, format!("TCP reachable; auth probe unavailable ({e}).")),
                }
            }
            "mysql" | "mariadb" => {
                let port_str = host.port.to_string();
                let user_arg = format!("-u{}", host.username);
                let pw_arg = format!("-p{}", password);
                let host_arg = format!("-h{}", host.host);
                let port_arg = format!("-P{}", port_str);
                let args: Vec<&str> = vec![
                    "mysqladmin",
                    &host_arg,
                    &port_arg,
                    &user_arg,
                    &pw_arg,
                    "ping",
                ];
                match docker_probe("mysql:8.4", &args, &[]).await {
                    Ok((true, _)) => (true, "MySQL authentication succeeded.".into()),
                    Ok((false, msg)) => (false, format!("MySQL probe failed: {msg}")),
                    Err(e) => (true, format!("TCP reachable; auth probe unavailable ({e}).")),
                }
            }
            "redis" => {
                let port_str = host.port.to_string();
                let args: Vec<&str> = vec![
                    "redis-cli", "-h", &host.host, "-p", &port_str, "-a", &password, "PING",
                ];
                match docker_probe("redis:7.4-alpine", &args, &[]).await {
                    Ok((true, msg)) if msg.contains("PONG") => {
                        (true, "Redis authentication succeeded.".into())
                    }
                    Ok((true, _)) => (true, "Redis reachable.".into()),
                    Ok((false, msg)) => (false, format!("Redis probe failed: {msg}")),
                    Err(e) => (true, format!("TCP reachable; auth probe unavailable ({e}).")),
                }
            }
            "mongodb" => {
                let uri = build_remote_uri(&host, &password);
                let args: Vec<&str> = vec![
                    "mongosh",
                    &uri,
                    "--quiet",
                    "--eval",
                    "db.runCommand({ping:1}).ok",
                ];
                match docker_probe("mongo:7", &args, &[]).await {
                    Ok((true, _)) => (true, "MongoDB authentication succeeded.".into()),
                    Ok((false, msg)) => (false, format!("MongoDB probe failed: {msg}")),
                    Err(e) => (true, format!("TCP reachable; auth probe unavailable ({e}).")),
                }
            }
            "clickhouse" => {
                let port_str = host.port.to_string();
                let pw_arg = format!("--password={}", password);
                let user_arg = format!("--user={}", host.username);
                let host_arg = format!("--host={}", host.host);
                let port_arg = format!("--port={}", port_str);
                let args: Vec<&str> = vec![
                    "clickhouse-client",
                    &host_arg,
                    &port_arg,
                    &user_arg,
                    &pw_arg,
                    "--query",
                    "SELECT 1",
                ];
                match docker_probe("clickhouse/clickhouse-server:24.8", &args, &[]).await {
                    Ok((true, _)) => (true, "ClickHouse authentication succeeded.".into()),
                    Ok((false, msg)) => (false, format!("ClickHouse probe failed: {msg}")),
                    Err(e) => (true, format!("TCP reachable; auth probe unavailable ({e}).")),
                }
            }
            "pocketbase" => {
                // PocketBase is HTTP — TCP open is enough for a v1 health check.
                (true, "PocketBase HTTP port is reachable.".into())
            }
            _ => (true, "TCP reachable. Auth probe not implemented for this service.".into()),
        }
    } else {
        (
            true,
            "TCP reachable. No saved password — set credentials to enable auth probe.".into(),
        )
    };

    let result = RemoteConnectionResult {
        healthy,
        latency_ms: start.elapsed().as_millis() as u64,
        message,
    };

    append_audit_event(
        &app,
        AuditEvent {
            id: uuid_v4(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "remote.host.test".into(),
            instance_id: host.id.clone(),
            instance_name: host.name.clone(),
            service_type: host.service_type.clone(),
            environment: host.environment.clone(),
            outcome: if result.healthy { "success" } else { "error" }.into(),
            detail: Some(result.message.clone()),
        },
    );

    Ok(result)
}
