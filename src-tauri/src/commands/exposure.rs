use crate::commands::instances::uuid_v4;
use crate::local_store::{
    append_audit_event, load_store, save_store, AuditEvent, Exposure, LocalInstance,
};
use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Command as TokioCommand;

// ── Step preview types ─────────────────────────────────────────────────────

/// A user-facing description of a single step that will execute when an
/// exposure is created. Intentionally human-readable — never raw shell.
#[derive(Debug, Serialize, Clone)]
pub struct ExposureStep {
    pub step: u8,
    pub title: String,
    pub description: String,
    /// "info" | "action" | "warning"
    pub kind: String,
}

#[derive(Debug, Serialize)]
pub struct ExposurePreview {
    pub method: String,
    pub steps: Vec<ExposureStep>,
    pub expected_endpoint: Option<String>,
    pub warnings: Vec<String>,
}

// ── Input types ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ExposureRequest {
    pub instance_id: String,
    /// "direct" | "cloudflare" | "ngrok" | "nginx"
    pub method: String,
    pub external_port: Option<u16>,
    pub hostname: Option<String>,
    /// ngrok auth token (only stored in keyring, never persisted in struct)
    pub ngrok_token: Option<String>,
}

// ── Helpers ────────────────────────────────────────────────────────────────

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

fn find_instance(app: &AppHandle, instance_id: &str) -> Result<LocalInstance, String> {
    load_store(app)
        .instances
        .iter()
        .find(|i| i.id == instance_id)
        .cloned()
        .ok_or_else(|| "Instance not found.".into())
}

fn check_active_exposure(
    app: &AppHandle,
    instance_id: &str,
    method: &str,
) -> Result<(), String> {
    let store = load_store(app);
    if store
        .exposures
        .iter()
        .any(|e| e.instance_id == instance_id && e.method == method && e.status == "active")
    {
        return Err(format!(
            "An active {method} exposure already exists for this instance. Remove it first."
        ));
    }
    Ok(())
}

fn validate_method(m: &str) -> Result<(), String> {
    match m {
        "direct" | "cloudflare" | "ngrok" | "nginx" => Ok(()),
        other => Err(format!("Unknown exposure method: {other}")),
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn save_exposure(app: &AppHandle, exposure: &Exposure) -> Result<(), String> {
    let mut store = load_store(app);
    if let Some(existing) = store
        .exposures
        .iter_mut()
        .find(|e| e.id == exposure.id)
    {
        *existing = exposure.clone();
    } else {
        store.exposures.push(exposure.clone());
    }
    save_store(app, &store)
}

fn remove_exposure_record(app: &AppHandle, exposure_id: &str) -> Result<Option<Exposure>, String> {
    let mut store = load_store(app);
    let removed = store
        .exposures
        .iter()
        .find(|e| e.id == exposure_id)
        .cloned();
    store.exposures.retain(|e| e.id != exposure_id);
    save_store(app, &store)?;
    Ok(removed)
}

fn audit(
    app: &AppHandle,
    action: &str,
    instance: &LocalInstance,
    outcome: &str,
    detail: Option<String>,
) {
    append_audit_event(
        app,
        AuditEvent {
            id: uuid_v4(),
            timestamp: now(),
            action: action.into(),
            instance_id: instance.id.clone(),
            instance_name: instance.name.clone(),
            service_type: instance.service_type.clone(),
            environment: instance.environment.clone(),
            outcome: outcome.into(),
            detail,
        },
    );
}

/// Best-effort attempt to discover the local machine's primary outbound IP.
/// Falls back to "<your-public-ip>" placeholder if detection fails.
fn detect_external_ip() -> String {
    use std::net::{IpAddr, UdpSocket};
    let socket = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return "<your-public-ip>".into(),
    };
    if socket.connect("8.8.8.8:80").is_err() {
        return "<your-public-ip>".into();
    }
    match socket.local_addr() {
        Ok(addr) => match addr.ip() {
            IpAddr::V4(v) => v.to_string(),
            IpAddr::V6(v) => v.to_string(),
        },
        Err(_) => "<your-public-ip>".into(),
    }
}

fn binary_on_path(name: &str) -> bool {
    let probe = if cfg!(target_os = "windows") {
        Command::new("where").arg(name).output()
    } else {
        Command::new("which").arg(name).output()
    };
    matches!(probe, Ok(o) if o.status.success())
}

// ── Tool management ────────────────────────────────────────────────────────

/// Returns `~/.baseport/bin` (Windows: `%APPDATA%\.baseport\bin`), creating it if needed.
fn app_bin_dir() -> Result<std::path::PathBuf, String> {
    let base = if cfg!(target_os = "windows") {
        std::env::var("APPDATA")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default()
    } else {
        std::env::var("HOME").unwrap_or_default()
    };
    if base.is_empty() {
        return Err("Cannot determine home directory.".into());
    }
    let dir = std::path::PathBuf::from(&base).join(".baseport").join("bin");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create tool directory: {e}"))?;
    Ok(dir)
}

/// Check PATH first, then `~/.baseport/bin`. Returns the path to use in Command::new.
fn find_binary(name: &str) -> Option<String> {
    if binary_on_path(name) {
        return Some(name.to_string());
    }
    let Ok(dir) = app_bin_dir() else {
        return None;
    };
    let p = if cfg!(target_os = "windows") {
        dir.join(format!("{name}.exe"))
    } else {
        dir.join(name)
    };
    if p.exists() {
        Some(p.to_string_lossy().into_owned())
    } else {
        None
    }
}

fn cloudflared_download_url() -> (&'static str, &'static str) {
    if cfg!(target_os = "windows") {
        (
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
            "cloudflared.exe",
        )
    } else if cfg!(target_os = "macos") {
        (
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64",
            "cloudflared",
        )
    } else {
        (
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
            "cloudflared",
        )
    }
}

// Progress event payload emitted during binary downloads.
#[derive(Debug, Serialize, Clone)]
struct DownloadProgress {
    tool: String,
    /// Bytes downloaded so far (polled from the destination file size).
    downloaded: u64,
    /// Phase: "downloading" | "complete" | "error"
    phase: String,
    message: String,
}

async fn download_file_with_progress(
    app: &AppHandle,
    tool: &str,
    url: &str,
    dest: &std::path::Path,
) -> Result<(), String> {
    let dest_str = dest.to_string_lossy().to_string();

    // Emit "starting" event so the frontend can show an animated bar immediately.
    let _ = app.emit(
        "tool-download-progress",
        DownloadProgress {
            tool: tool.to_string(),
            downloaded: 0,
            phase: "downloading".into(),
            message: format!("Connecting to download server…"),
        },
    );

    // Spawn a side-task that polls the partially-written destination file
    // every 400ms and emits progress events until the main download finishes.
    let dest_clone = dest.to_path_buf();
    let app_clone = app.clone();
    let tool_clone = tool.to_string();
    let poller = tokio::task::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(400));
        loop {
            interval.tick().await;
            let downloaded = std::fs::metadata(&dest_clone)
                .map(|m| m.len())
                .unwrap_or(0);
            let mb = downloaded / (1024 * 1024);
            let _ = app_clone.emit(
                "tool-download-progress",
                DownloadProgress {
                    tool: tool_clone.clone(),
                    downloaded,
                    phase: "downloading".into(),
                    message: format!("Downloading… {mb} MB received"),
                },
            );
        }
    });

    let result = if cfg!(target_os = "windows") {
        // curl.exe ships with Windows 10 1803+; use it for consistent behaviour.
        let out = TokioCommand::new("curl")
            .args(["-fL", "--silent", "--output", &dest_str, url])
            .output()
            .await
            .map_err(|e| format!("curl download failed to launch: {e}"))?;
        if !out.status.success() {
            Err(format!(
                "Download failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        } else {
            Ok(())
        }
    } else {
        let out = TokioCommand::new("curl")
            .args(["-fsSL", "--output", &dest_str, url])
            .output()
            .await
            .map_err(|e| format!("curl download failed to launch: {e}"))?;
        if !out.status.success() {
            Err(format!(
                "Download failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        } else {
            Ok(())
        }
    };

    poller.abort();

    let final_size = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    let (phase, message) = if result.is_ok() {
        let mb = final_size / (1024 * 1024);
        ("complete".to_string(), format!("Download complete — {mb} MB"))
    } else {
        ("error".to_string(), result.as_ref().err().cloned().unwrap_or_default())
    };
    let _ = app.emit(
        "tool-download-progress",
        DownloadProgress {
            tool: tool.to_string(),
            downloaded: final_size,
            phase,
            message,
        },
    );

    result
}

#[derive(Debug, Serialize)]
pub struct ToolStatus {
    pub available: bool,
    pub path: Option<String>,
    pub download_url: Option<String>,
}

#[tauri::command]
pub async fn check_tool_available(tool: String) -> Result<ToolStatus, String> {
    let path = find_binary(&tool);
    let available = path.is_some();
    let download_url = match tool.as_str() {
        "cloudflared" => Some(cloudflared_download_url().0.to_string()),
        "ngrok" => Some("https://ngrok.com/download".to_string()),
        _ => None,
    };
    Ok(ToolStatus {
        available,
        path,
        download_url,
    })
}

#[tauri::command]
pub async fn download_and_install_tool(app: AppHandle, tool: String) -> Result<String, String> {
    match tool.as_str() {
        "cloudflared" => {
            let (url, filename) = cloudflared_download_url();
            let bin_dir = app_bin_dir()?;
            let dest = bin_dir.join(filename);
            download_file_with_progress(&app, "cloudflared", url, &dest).await?;
            // Mark executable on non-Windows
            #[cfg(not(target_os = "windows"))]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("Failed to set executable bit: {e}"))?;
            }
            Ok(dest.to_string_lossy().into_owned())
        }
        _ => Err(format!(
            "{tool} must be installed manually — visit the download page for your OS."
        )),
    }
}

#[derive(Debug, Serialize)]
pub struct FirewallResult {
    pub success: bool,
    pub message: String,
    pub manual_command: Option<String>,
}

#[tauri::command]
pub async fn add_firewall_rule(
    app: AppHandle,
    port: u16,
    rule_name: String,
    // If provided and the rule is added successfully, the rule name is stored
    // on the exposure record so it can be removed automatically on teardown.
    exposure_id: Option<String>,
) -> Result<FirewallResult, String> {
    if port == 0 {
        return Err("Invalid port.".into());
    }
    // Allowlist rule_name to prevent injection
    if !rule_name
        .chars()
        .all(|c| c.is_alphanumeric() || c == ' ' || c == '-' || c == '_')
    {
        return Err("Invalid rule name.".into());
    }

    if cfg!(target_os = "windows") {
        let cmd_manual = format!(
            r#"netsh advfirewall firewall add rule name="{rule_name}" dir=in action=allow protocol=TCP localport={port}"#
        );

        // Build the cmd.exe /c argument string.  Single-quoted in PowerShell so embedded
        // double-quotes are passed through verbatim to cmd/netsh.
        let cmd_args = format!(
            r#"/c netsh advfirewall firewall add rule name="{rule_name}" dir=in action=allow protocol=TCP localport={port}"#
        );
        // Start-Process -Verb RunAs triggers the UAC elevation dialog.
        // -WindowStyle Hidden prevents the cmd window from flashing.
        // -Wait blocks until netsh finishes.
        let ps = format!(
            "Start-Process -FilePath cmd.exe -ArgumentList '{cmd_args}' -Verb RunAs -Wait -WindowStyle Hidden"
        );

        let out = TokioCommand::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .output()
            .await
            .map_err(|e| format!("Failed to spawn UAC prompt: {e}"))?;

        if out.status.success() {
            // Persist the rule name so teardown can remove it later.
            if let Some(eid) = &exposure_id {
                let _ = record_exposure_firewall_rule(&app, eid, &rule_name);
            }
            return Ok(FirewallResult {
                success: true,
                message: format!(
                    "Windows Firewall inbound rule \"{rule_name}\" added for port {port}."
                ),
                manual_command: None,
            });
        }

        // User cancelled the UAC prompt or elevation was denied.
        Ok(FirewallResult {
            success: false,
            message: "Firewall rule was not added — UAC was cancelled or access was denied. \
                      You can run the command below manually as Administrator:"
                .into(),
            manual_command: Some(cmd_manual),
        })
    } else if cfg!(target_os = "macos") {
        Ok(FirewallResult {
            success: false,
            message: "macOS firewall is usually open for outbound-initiated connections. If needed, add a pf rule.".into(),
            manual_command: Some(format!(
                "# Add to /etc/pf.conf and run: sudo pfctl -f /etc/pf.conf\npass in proto tcp from any to any port {port}"
            )),
        })
    } else {
        // Linux: try ufw, fall back to iptables
        let ufw_out = TokioCommand::new("ufw")
            .args(["allow", &format!("{port}/tcp")])
            .output()
            .await;
        if let Ok(o) = ufw_out {
            if o.status.success() {
                if let Some(eid) = &exposure_id {
                    let _ = record_exposure_firewall_rule(&app, eid, &rule_name);
                }
                return Ok(FirewallResult {
                    success: true,
                    message: format!("UFW rule added — port {port}/tcp is now allowed."),
                    manual_command: None,
                });
            }
        }
        let ipt_out = TokioCommand::new("iptables")
            .args([
                "-A",
                "INPUT",
                "-p",
                "tcp",
                "--dport",
                &port.to_string(),
                "-j",
                "ACCEPT",
            ])
            .output()
            .await;
        if let Ok(o) = ipt_out {
            if o.status.success() {
                if let Some(eid) = &exposure_id {
                    let _ = record_exposure_firewall_rule(&app, eid, &rule_name);
                }
                return Ok(FirewallResult {
                    success: true,
                    message: format!("iptables rule added — port {port} is now allowed."),
                    manual_command: None,
                });
            }
        }
        Ok(FirewallResult {
            success: false,
            message: "Could not add rule automatically (may need sudo).".into(),
            manual_command: Some(format!("sudo ufw allow {port}/tcp")),
        })
    }
}

/// Persist the Windows/Linux firewall rule name onto an exposure record.
fn record_exposure_firewall_rule(
    app: &AppHandle,
    exposure_id: &str,
    rule_name: &str,
) -> Result<(), String> {
    let mut store = load_store(app);
    if let Some(exp) = store.exposures.iter_mut().find(|e| e.id == exposure_id) {
        exp.firewall_rule_name = Some(rule_name.to_string());
        exp.updated_at = now();
    }
    save_store(app, &store)
}

/// Best-effort OS firewall rule deletion. Does not return errors — teardown
/// should never fail because of a missing firewall rule.
async fn delete_firewall_rule_os(rule_name: &str) {
    // Validate name before building any OS command.
    if !rule_name
        .chars()
        .all(|c| c.is_alphanumeric() || c == ' ' || c == '-' || c == '_')
    {
        return;
    }

    if cfg!(target_os = "windows") {
        let cmd_args = format!(
            r#"/c netsh advfirewall firewall delete rule name="{rule_name}""#
        );
        let ps = format!(
            "Start-Process -FilePath cmd.exe -ArgumentList '{cmd_args}' -Verb RunAs -Wait -WindowStyle Hidden"
        );
        let _ = TokioCommand::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .output()
            .await;
    } else if cfg!(target_os = "linux") {
        // Try ufw first, then iptables (best-effort; ignore errors).
        let _ = TokioCommand::new("ufw")
            .args(["delete", "allow", &format!("{rule_name}/tcp")])
            .output()
            .await;
    }
    // macOS: no rule was added programmatically, nothing to remove.
}

/// Stop all active exposures for `instance_id`, remove their firewall rules,
/// and delete their store records. Called by stop_instance and delete_instance.
pub(crate) async fn teardown_exposures_for_instance(app: &AppHandle, instance_id: &str) {
    let store = load_store(app);
    let to_teardown: Vec<crate::local_store::Exposure> = store
        .exposures
        .iter()
        .filter(|e| e.instance_id == instance_id)
        .cloned()
        .collect();

    for exposure in to_teardown {
        // Stop the process/container — ignore errors (already stopped, etc.).
        let _ = match exposure.method.as_str() {
            "direct" => teardown_direct(app, &exposure).await,
            "ngrok" | "cloudflare" => teardown_child(app, &exposure).await,
            "nginx" => teardown_nginx(app, &exposure).await,
            _ => Ok(()),
        };
        // Remove the associated firewall rule if one was recorded.
        if let Some(ref rule) = exposure.firewall_rule_name {
            delete_firewall_rule_os(rule).await;
        }
        // Cloudflare tunnels get a new random URL on every start.
        // Instead of deleting the record, mark it "pending" so the next
        // instance start can auto-reprovision the tunnel.
        if exposure.method == "cloudflare" {
            let mut store = load_store(app);
            if let Some(exp) = store.exposures.iter_mut().find(|e| e.id == exposure.id) {
                exp.status = "pending".to_string();
                exp.external_endpoint = None;
                exp.pid = None;
                exp.error = None;
                exp.updated_at = now();
            }
            let _ = save_store(app, &store);
        } else {
            // Remove the store record so the UI doesn't show a stale exposure.
            let _ = remove_exposure_record(app, &exposure.id);
        }
    }
}

// ── Nginx helpers ──────────────────────────────────────────────────────────

fn nginx_work_dir(exposure_id: &str) -> std::path::PathBuf {
    let base = if cfg!(target_os = "windows") {
        std::env::var("APPDATA").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string())
    } else {
        std::env::var("HOME")
            .unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string())
    };
    std::path::PathBuf::from(base).join(".baseport").join("nginx").join(exposure_id)
}

/// Docker on Windows expects forward-slash volume paths.
fn docker_vol_path(p: &std::path::Path) -> String {
    if cfg!(target_os = "windows") {
        p.to_string_lossy().replace('\\', "/")
    } else {
        p.to_string_lossy().into_owned()
    }
}

fn nginx_container_name(exposure_id: &str) -> String {
    format!("bp_nginx_{}", exposure_id.trim_start_matches("expose_"))
}

// ── Preview builders ───────────────────────────────────────────────────────

fn preview_direct(req: &ExposureRequest, instance: &LocalInstance) -> ExposurePreview {
    let ext_port = req.external_port.unwrap_or(instance.port);
    let ip = detect_external_ip();
    let endpoint = format!("{ip}:{ext_port}");
    ExposurePreview {
        method: "direct".into(),
        steps: vec![
            ExposureStep {
                step: 1,
                title: "Start a port-forwarding sidecar".into(),
                description: format!(
                    "A small helper container will run on your machine that listens on \
                     port {ext_port} and forwards every connection to your \"{}\" database. \
                     Your original container is not modified.",
                    instance.name
                ),
                kind: "action".into(),
            },
            ExposureStep {
                step: 2,
                title: "Connect the sidecar to your database".into(),
                description:
                    "The helper joins a private Docker network with your database \
                     container so it can reach it directly."
                        .into(),
            kind: "action".into(),
            },
            ExposureStep {
                step: 3,
                title: "Verify the public port is open".into(),
                description: format!(
                    "Once the sidecar is running, your database will be reachable at {endpoint}. \
                     If you're behind a router or cloud firewall, you may need to forward / allow \
                     port {ext_port}."
                ),
                kind: "info".into(),
            },
        ],
        expected_endpoint: Some(endpoint),
        warnings: vec![
            "Direct exposure makes your database reachable from anywhere on the network. \
             Make sure your database has a strong password and, where possible, IP allowlisting."
                .into(),
            "If your machine is behind a NAT (home / office), you'll also need to set up port \
             forwarding on your router for outside-network access."
                .into(),
        ],
    }
}

fn preview_cloudflare(req: &ExposureRequest, instance: &LocalInstance) -> ExposurePreview {
    let _ = req;
    ExposurePreview {
        method: "cloudflare".into(),
        steps: vec![
            ExposureStep {
                step: 1,
                title: "Check that cloudflared is installed".into(),
                description:
                    "We'll look for the Cloudflare tunnel client (cloudflared) on your system. \
                     If it isn't installed, you'll be prompted to install it before continuing."
                        .into(),
                kind: "action".into(),
            },
            ExposureStep {
                step: 2,
                title: "Start a Cloudflare quick tunnel".into(),
                description: format!(
                    "A new background tunnel will point at your local \"{}\" service \
                     and Cloudflare will assign a public HTTPS URL.",
                    instance.name
                ),
                kind: "action".into(),
            },
            ExposureStep {
                step: 3,
                title: "Capture the public URL".into(),
                description:
                    "We'll watch the tunnel's output for the trycloudflare.com URL Cloudflare \
                     hands back, and save it as the public endpoint for this exposure."
                        .into(),
                kind: "info".into(),
            },
        ],
        expected_endpoint: None,
        warnings: vec![
            "Cloudflare quick tunnels work best for HTTP-based services (PocketBase, \
             ClickHouse). Raw database protocols (PostgreSQL, MySQL, MongoDB, Redis) require a \
             named tunnel + cloudflared on the client side, which isn't covered by this \
             one-click flow yet."
                .into(),
            "The trycloudflare.com URL is randomized and will change every time the tunnel \
             restarts. Use a named tunnel + custom domain for permanent URLs."
                .into(),
        ],
    }
}

fn preview_ngrok(req: &ExposureRequest, instance: &LocalInstance) -> ExposurePreview {
    let _ = req;
    ExposurePreview {
        method: "ngrok".into(),
        steps: vec![
            ExposureStep {
                step: 1,
                title: "Check that ngrok is installed".into(),
                description:
                    "We'll look for the ngrok client on your system. If it isn't installed, \
                     you'll be prompted to install it before continuing."
                        .into(),
                kind: "action".into(),
            },
            ExposureStep {
                step: 2,
                title: "Save your ngrok auth token".into(),
                description:
                    "Your token will be stored in your operating system's secure keychain. \
                     ngrok requires a token to start tunnels."
                        .into(),
                kind: "action".into(),
            },
            ExposureStep {
                step: 3,
                title: "Start an ngrok TCP tunnel".into(),
                description: format!(
                    "A background ngrok process will open a public TCP endpoint that forwards \
                     to your \"{}\" database on port {}.",
                    instance.name, instance.port
                ),
                kind: "action".into(),
            },
            ExposureStep {
                step: 4,
                title: "Capture the public address".into(),
                description:
                    "We'll ask ngrok for the public host:port it assigned and save it as the \
                     endpoint for this exposure."
                        .into(),
                kind: "info".into(),
            },
        ],
        expected_endpoint: None,
        warnings: vec![
            "ngrok's free tier gives you a random TCP address each time the tunnel restarts. \
             Reserve a TCP address in the ngrok dashboard for permanent endpoints."
                .into(),
            "Anyone who knows the public address can attempt to connect — make sure your \
             database password is strong."
                .into(),
        ],
    }
}

fn preview_nginx(req: &ExposureRequest, instance: &LocalInstance) -> ExposurePreview {
    let ext_port = req.external_port.unwrap_or(443);
    ExposurePreview {
        method: "nginx".into(),
        steps: vec![
            ExposureStep {
                step: 1,
                title: "Generate a self-signed TLS certificate".into(),
                description: format!(
                    "A short-lived TLS key + cert will be generated locally to encrypt traffic \
                     between clients and your \"{}\" service.",
                    instance.name
                ),
                kind: "action".into(),
            },
            ExposureStep {
                step: 2,
                title: "Start an nginx TLS proxy".into(),
                description: format!(
                    "An nginx container will listen on port {ext_port} with TLS, terminate \
                     encryption, and forward decrypted traffic to your local database container."
                ),
                kind: "action".into(),
            },
            ExposureStep {
                step: 3,
                title: "Verify the proxy is reachable".into(),
                description:
                    "We'll confirm nginx is healthy and serving on the chosen port.".into(),
                kind: "info".into(),
            },
        ],
        expected_endpoint: Some(format!("https://{}:{ext_port}", detect_external_ip())),
        warnings: vec![
            "The generated TLS certificate is self-signed. Clients will need to accept or \
             import it — browsers will show a security warning."
                .into(),
            "If your machine is behind a NAT or cloud firewall, forward port \
             <your chosen port> to reach this service from the internet."
                .into(),
        ],
    }
}

// ── Public commands ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn preview_exposure(
    app: AppHandle,
    request: ExposureRequest,
) -> Result<ExposurePreview, String> {
    validate_method(&request.method)?;
    let instance = find_instance(&app, &request.instance_id)?;
    if let Some(p) = request.external_port {
        if p < 1 {
            return Err("External port must be greater than 0.".into());
        }
    }
    let preview = match request.method.as_str() {
        "direct" => preview_direct(&request, &instance),
        "cloudflare" => preview_cloudflare(&request, &instance),
        "ngrok" => preview_ngrok(&request, &instance),
        "nginx" => preview_nginx(&request, &instance),
        _ => unreachable!(),
    };
    Ok(preview)
}

#[tauri::command]
pub async fn list_exposures(app: AppHandle) -> Result<Vec<Exposure>, String> {
    Ok(load_store(&app).exposures)
}

#[tauri::command]
pub async fn create_exposure(
    app: AppHandle,
    request: ExposureRequest,
) -> Result<Exposure, String> {
    validate_method(&request.method)?;
    let instance = find_instance(&app, &request.instance_id)?;
    check_active_exposure(&app, &request.instance_id, &request.method)?;

    let result = match request.method.as_str() {
        "direct" => create_direct(&app, &request, &instance).await,
        "ngrok" => create_ngrok(&app, &request, &instance).await,
        "cloudflare" => create_cloudflare(&app, &request, &instance).await,
        "nginx" => create_nginx(&app, &request, &instance).await,
        _ => unreachable!(),
    };

    match &result {
        Ok(exposure) => audit(
            &app,
            "exposure.create",
            &instance,
            "success",
            Some(format!(
                "Method: {}, endpoint: {}",
                exposure.method,
                exposure.external_endpoint.clone().unwrap_or_default()
            )),
        ),
        Err(e) => audit(
            &app,
            "exposure.create",
            &instance,
            "error",
            Some(format!("Method: {}, error: {e}", request.method)),
        ),
    }
    result
}

#[tauri::command]
pub async fn remove_exposure(app: AppHandle, exposure_id: String) -> Result<(), String> {
    let store = load_store(&app);
    let exposure = store
        .exposures
        .iter()
        .find(|e| e.id == exposure_id)
        .cloned()
        .ok_or("Exposure not found.")?;
    let instance = find_instance(&app, &exposure.instance_id).ok();

    let result = match exposure.method.as_str() {
        "direct" => teardown_direct(&app, &exposure).await,
        "ngrok" => teardown_child(&app, &exposure).await,
        "cloudflare" => teardown_child(&app, &exposure).await,
        "nginx" => teardown_nginx(&app, &exposure).await,
        _ => Ok(()),
    };

    // Always remove the record so the UI doesn't get stuck on a partial teardown.
    remove_exposure_record(&app, &exposure_id)?;

    if let Some(inst) = instance {
        match &result {
            Ok(_) => audit(
                &app,
                "exposure.remove",
                &inst,
                "success",
                Some(format!("Method: {}", exposure.method)),
            ),
            Err(e) => audit(
                &app,
                "exposure.remove",
                &inst,
                "error",
                Some(format!(
                    "Method: {}, partial teardown error: {e}",
                    exposure.method
                )),
            ),
        }
    }
    result
}

// ── Direct bind (socat sidecar) ────────────────────────────────────────────

const SOCAT_IMAGE: &str = "alpine/socat:latest";

fn direct_network_name(exposure_id: &str) -> String {
    format!("bp_expose_{}", exposure_id.trim_start_matches("expose_"))
}

fn direct_container_name(exposure_id: &str) -> String {
    format!("bp_proxy_{}", exposure_id.trim_start_matches("expose_"))
}

async fn create_direct(
    app: &AppHandle,
    req: &ExposureRequest,
    instance: &LocalInstance,
) -> Result<Exposure, String> {
    let exposure_id = format!("expose_{}", uuid_v4());
    let ext_port = req.external_port.unwrap_or(instance.port);
    if ext_port < 1 {
        return Err("External port must be greater than 0.".into());
    }
    if ext_port == instance.port {
        return Err(format!(
            "Port {ext_port} is already published by the database container on this host. \
             Choose a different external port (e.g. {}).",
            instance.port.saturating_add(10000)
        ));
    }
    let net = direct_network_name(&exposure_id);
    let proxy = direct_container_name(&exposure_id);

    // Discover the container's listening port from the LocalInstance — that
    // matches the host->container binding we set up when creating the
    // instance, and the proxy connects on the container's internal port.
    let internal_port = container_internal_port(&instance.service_type);

    // 1) Create a private network for the proxy + DB
    let out = docker_cmd(app)
        .args(["network", "create", &net])
        .output()
        .map_err(|e| format!("docker network create failed to launch: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !stderr.contains("already exists") {
            return Err(format!("Failed to create proxy network: {stderr}"));
        }
    }

    // 2) Attach the DB container to that network (idempotent — ignore "already exists")
    let out = docker_cmd(app)
        .args(["network", "connect", &net, &instance.container_name])
        .output()
        .map_err(|e| format!("docker network connect failed to launch: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !stderr.contains("already exists") && !stderr.contains("is already connected") {
            // Roll back the network we just created
            let _ = docker_cmd(app).args(["network", "rm", &net]).output();
            return Err(format!("Failed to attach instance to proxy network: {stderr}"));
        }
    }

    // 3) Run the socat sidecar
    let listen_spec = format!(
        "TCP-LISTEN:{internal_port},fork,reuseaddr"
    );
    let target_spec = format!("TCP:{}:{internal_port}", instance.container_name);
    let port_bind = format!("0.0.0.0:{ext_port}:{internal_port}");

    let out = docker_cmd(app)
        .args([
            "run",
            "-d",
            "--name",
            &proxy,
            "--restart",
            "unless-stopped",
            "--network",
            &net,
            "-p",
            &port_bind,
            "--label",
            &format!("app.securedbmanager.exposure_id={exposure_id}"),
            "--label",
            &format!("app.securedbmanager.instance_id={}", instance.id),
            SOCAT_IMAGE,
            &listen_spec,
            &target_spec,
        ])
        .output()
        .map_err(|e| format!("docker run failed to launch: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // Best-effort rollback
        let _ = docker_cmd(app)
            .args(["network", "disconnect", &net, &instance.container_name])
            .output();
        let _ = docker_cmd(app).args(["network", "rm", &net]).output();
        return Err(format!("Failed to start proxy container: {stderr}"));
    }

    let endpoint = format!("{}:{ext_port}", detect_external_ip());
    let exposure = Exposure {
        id: exposure_id,
        instance_id: instance.id.clone(),
        method: "direct".into(),
        status: "active".into(),
        external_endpoint: Some(endpoint),
        external_port: Some(ext_port),
        provider_id: None,
        pid: None,
        hostname: None,
        error: None,
        firewall_rule_name: None,
        created_at: now(),
        updated_at: now(),
    };
    save_exposure(app, &exposure)?;
    Ok(exposure)
}

async fn teardown_direct(app: &AppHandle, exposure: &Exposure) -> Result<(), String> {
    let net = direct_network_name(&exposure.id);
    let proxy = direct_container_name(&exposure.id);

    // Stop + remove the proxy container (best-effort)
    let _ = docker_cmd(app).args(["stop", &proxy]).output();
    let _ = docker_cmd(app).args(["rm", "-f", &proxy]).output();

    // Disconnect the original DB container from the proxy network if it's still attached
    if let Ok(instance) = find_instance(app, &exposure.instance_id) {
        let _ = docker_cmd(app)
            .args(["network", "disconnect", &net, &instance.container_name])
            .output();
    }

    // Drop the network last (best-effort; will fail silently if still in use)
    let _ = docker_cmd(app).args(["network", "rm", &net]).output();
    Ok(())
}

/// Return the in-container listening port for each service. Mirrors
/// service_config in instances.rs so we don't have to re-export it.
fn container_internal_port(service_type: &str) -> u16 {
    match service_type {
        "postgres" => 5432,
        "mysql" | "mariadb" => 3306,
        "redis" => 6379,
        "mongodb" => 27017,
        "clickhouse" => 8123,
        "pocketbase" => 8090,
        _ => 0,
    }
}

// ── Cloudflare quick tunnel ────────────────────────────────────────────────

/// Inner logic: spawn a cloudflared process for `exposure_id` and return the
/// public URL. Stores the child handle in `AppState.exposure_children`.
async fn spawn_cloudflare_tunnel(
    app: &AppHandle,
    exposure_id: &str,
    instance: &LocalInstance,
) -> Result<String, String> {
    let cloudflared_bin = find_binary("cloudflared").ok_or_else(|| {
        "cloudflared is not installed. Use the Install button in the wizard to download it \
         automatically, or visit https://github.com/cloudflare/cloudflared/releases"
            .to_string()
    })?;

    let url = format!("http://localhost:{}", instance.port);

    let mut child = Command::new(&cloudflared_bin)
        .args(["tunnel", "--no-autoupdate", "--url", &url])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch cloudflared: {e}"))?;

    // Read stderr (cloudflared prints the public URL to stderr) for up to 20s.
    let public_url = read_url_from_child_stderr(&mut child, "trycloudflare.com", 20).await;

    match public_url {
        Some(url) => {
            let state = app.state::<crate::AppState>();
            state
                .exposure_children
                .lock()
                .unwrap()
                .insert(exposure_id.to_string(), child);
            Ok(url)
        }
        None => {
            let _ = child.kill();
            Err(
                "Cloudflared started but didn't return a public URL within 20s. \
                 Check that the service is actually listening locally."
                    .into(),
            )
        }
    }
}

async fn create_cloudflare(
    app: &AppHandle,
    _req: &ExposureRequest,
    instance: &LocalInstance,
) -> Result<Exposure, String> {
    let exposure_id = format!("expose_{}", uuid_v4());

    let public_url = spawn_cloudflare_tunnel(app, &exposure_id, instance).await?;

    let exposure = Exposure {
        id: exposure_id,
        instance_id: instance.id.clone(),
        method: "cloudflare".into(),
        status: "active".into(),
        external_endpoint: Some(public_url),
        external_port: None,
        provider_id: None,
        pid: None,
        hostname: None,
        error: None,
        firewall_rule_name: None,
        created_at: now(),
        updated_at: now(),
    };
    save_exposure(app, &exposure)?;
    Ok(exposure)
}

/// Re-spawn cloudflare tunnels for any "pending" cloudflare exposures belonging
/// to `instance_id`. Called automatically after `start_local_instance` and as
/// a manual trigger from the frontend when the exposures page loads.
pub(crate) async fn reprovision_cloudflare_exposures_inner(
    app: &AppHandle,
    instance_id: &str,
) -> Vec<Exposure> {
    let store = load_store(app);
    let pending: Vec<crate::local_store::Exposure> = store
        .exposures
        .iter()
        .filter(|e| {
            e.instance_id == instance_id
                && e.method == "cloudflare"
                && e.status == "pending"
        })
        .cloned()
        .collect();

    let mut results = Vec::new();
    for mut exposure in pending {
        let instance = match find_instance(app, &exposure.instance_id) {
            Ok(i) => i,
            Err(_) => continue,
        };

        match spawn_cloudflare_tunnel(app, &exposure.id, &instance).await {
            Ok(endpoint) => {
                let mut store = load_store(app);
                if let Some(exp) = store.exposures.iter_mut().find(|e| e.id == exposure.id) {
                    exp.status = "active".to_string();
                    exp.external_endpoint = Some(endpoint.clone());
                    exp.error = None;
                    exp.updated_at = now();
                }
                let _ = save_store(app, &store);
                exposure.status = "active".to_string();
                exposure.external_endpoint = Some(endpoint);
                results.push(exposure);
            }
            Err(e) => {
                let mut store = load_store(app);
                if let Some(exp) = store.exposures.iter_mut().find(|e| e.id == exposure.id) {
                    exp.status = "error".to_string();
                    exp.error = Some(e.clone());
                    exp.updated_at = now();
                }
                let _ = save_store(app, &store);
            }
        }
    }
    results
}

#[tauri::command]
pub async fn reprovision_cloudflare_exposures(
    app: AppHandle,
    instance_id: String,
) -> Result<Vec<Exposure>, String> {
    Ok(reprovision_cloudflare_exposures_inner(&app, &instance_id).await)
}

/// Kill the running cloudflared tunnel for `exposure_id` (if any) and spawn a
/// fresh one. Works regardless of the current exposure status. Returns the
/// updated `Exposure`.
#[tauri::command]
pub async fn regenerate_cloudflare_exposure(
    app: AppHandle,
    exposure_id: String,
) -> Result<Exposure, String> {
    // Kill the old child process if it's still tracked.
    {
        let state = app.state::<crate::AppState>();
        let child_opt = state
            .exposure_children
            .lock()
            .unwrap()
            .remove(&exposure_id);
        if let Some(mut child) = child_opt {
            let _ = child.kill();
        }
    };

    // Look up the exposure record.
    let store = load_store(&app);
    let exposure = store
        .exposures
        .iter()
        .find(|e| e.id == exposure_id)
        .cloned()
        .ok_or_else(|| format!("Exposure '{exposure_id}' not found"))?;

    let instance = find_instance(&app, &exposure.instance_id)?;

    // Spawn a fresh tunnel.
    match spawn_cloudflare_tunnel(&app, &exposure_id, &instance).await {
        Ok(endpoint) => {
            let mut store = load_store(&app);
            if let Some(exp) = store.exposures.iter_mut().find(|e| e.id == exposure_id) {
                exp.status = "active".to_string();
                exp.external_endpoint = Some(endpoint.clone());
                exp.error = None;
                exp.updated_at = now();
            }
            save_store(&app, &store)?;
            let updated = store
                .exposures
                .iter()
                .find(|e| e.id == exposure_id)
                .cloned()
                .unwrap();
            Ok(updated)
        }
        Err(e) => {
            let mut store = load_store(&app);
            if let Some(exp) = store.exposures.iter_mut().find(|e| e.id == exposure_id) {
                exp.status = "error".to_string();
                exp.error = Some(e.clone());
                exp.updated_at = now();
            }
            let _ = save_store(&app, &store);
            Err(e)
        }
    }
}

// ── ngrok ──────────────────────────────────────────────────────────────────

async fn create_ngrok(
    app: &AppHandle,
    req: &ExposureRequest,
    instance: &LocalInstance,
) -> Result<Exposure, String> {
    let ngrok_bin = find_binary("ngrok").ok_or_else(|| {
        "ngrok is not installed. Visit https://ngrok.com/download, install it, then provide \
         your auth token here."
            .to_string()
    })?;

    // Persist the ngrok token to keyring if provided
    if let Some(tok) = &req.ngrok_token {
        if !tok.is_empty() {
            crate::commands::instances::store_password("service_ngrok_token", tok)?;
        }
    }
    let token = crate::commands::instances::read_password_opt("service_ngrok_token")
        .ok()
        .flatten()
        .ok_or("No ngrok auth token saved. Provide one to start the tunnel.")?;

    let exposure_id = format!("expose_{}", uuid_v4());
    let port_str = instance.port.to_string();

    let mut child = Command::new(&ngrok_bin)
        .args([
            "tcp",
            &port_str,
            "--authtoken",
            &token,
            "--log=stdout",
            "--log-format=json",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch ngrok: {e}"))?;

    let pid = child.id();

    // Poll ngrok's local API for the assigned tunnel URL
    let endpoint = poll_ngrok_api(20).await;
    match endpoint {
        Some(url) => {
            let state = app.state::<crate::AppState>();
            state
                .exposure_children
                .lock()
                .unwrap()
                .insert(exposure_id.clone(), child);

            let exposure = Exposure {
                id: exposure_id,
                instance_id: instance.id.clone(),
                method: "ngrok".into(),
                status: "active".into(),
                external_endpoint: Some(url),
                external_port: None,
                provider_id: None,
                pid: Some(pid),
                hostname: None,
                error: None,
                firewall_rule_name: None,
                created_at: now(),
                updated_at: now(),
            };
            save_exposure(app, &exposure)?;
            Ok(exposure)
        }
        None => {
            let _ = child.kill();
            Err("ngrok started but didn't report a public URL within 20s.".into())
        }
    }
}

// ── nginx TLS reverse proxy ───────────────────────────────────────────────

async fn create_nginx(
    app: &AppHandle,
    req: &ExposureRequest,
    instance: &LocalInstance,
) -> Result<Exposure, String> {
    let exposure_id = format!("expose_{}", uuid_v4());
    let ext_port = req.external_port.unwrap_or(8443);
    if ext_port == instance.port {
        return Err(format!(
            "Port {ext_port} is already published by the database container. \
             Choose a different port (e.g. {}).",
            ext_port.saturating_add(10000)
        ));
    }
    let internal_port = container_internal_port(&instance.service_type);

    // Working directory for certs + nginx.conf
    let work_dir = nginx_work_dir(&exposure_id);
    std::fs::create_dir_all(&work_dir)
        .map_err(|e| format!("Cannot create nginx working directory: {e}"))?;
    let work_dir_docker = docker_vol_path(&work_dir);

    // Generate self-signed TLS cert natively (no Docker needed)
    let ip = detect_external_ip();
    let cert_path = work_dir.join("server.crt");
    let key_path = work_dir.join("server.key");
    {
        use rcgen::{generate_simple_self_signed, CertifiedKey};
        let sans = vec![ip.clone(), "localhost".to_string()];
        let CertifiedKey { cert, key_pair } = generate_simple_self_signed(sans)
            .map_err(|e| format!("TLS certificate generation failed: {e}"))?;
        std::fs::write(&cert_path, cert.pem())
            .map_err(|e| format!("Failed to write server.crt: {e}"))?;
        std::fs::write(&key_path, key_pair.serialize_pem())
            .map_err(|e| format!("Failed to write server.key: {e}"))?;
    }

    // Write nginx.conf — use `stream {}` for raw TCP protocols, `http {}` for HTTP services
    let is_http = matches!(instance.service_type.as_str(), "pocketbase" | "clickhouse");
    let container = &instance.container_name;
    let nginx_conf_content = if is_http {
        format!(
            r#"events {{}}
http {{
    server {{
        listen {ext_port} ssl;
        ssl_certificate /etc/nginx/certs/server.crt;
        ssl_certificate_key /etc/nginx/certs/server.key;
        ssl_session_cache shared:SSL:1m;
        ssl_session_timeout 10m;
        location / {{
            proxy_pass http://{container}:{internal_port};
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto https;
        }}
    }}
}}
"#
        )
    } else {
        format!(
            r#"events {{}}
stream {{
    upstream backend {{
        server {container}:{internal_port};
    }}
    server {{
        listen {ext_port} ssl;
        ssl_certificate /etc/nginx/certs/server.crt;
        ssl_certificate_key /etc/nginx/certs/server.key;
        ssl_session_cache shared:SSL:1m;
        ssl_session_timeout 10m;
        proxy_pass backend;
    }}
}}
"#
        )
    };
    let conf_path = work_dir.join("nginx.conf");
    std::fs::write(&conf_path, &nginx_conf_content)
        .map_err(|e| format!("Failed to write nginx.conf: {e}"))?;

    // Create private network
    let net = direct_network_name(&exposure_id);
    let out = docker_cmd(app)
        .args(["network", "create", &net])
        .output()
        .map_err(|e| format!("docker network create failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !stderr.contains("already exists") {
            return Err(format!("Failed to create proxy network: {stderr}"));
        }
    }

    // Attach DB container to network
    let out = docker_cmd(app)
        .args(["network", "connect", &net, &instance.container_name])
        .output()
        .map_err(|e| format!("docker network connect failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if !stderr.contains("already exists") && !stderr.contains("is already connected") {
            let _ = docker_cmd(app).args(["network", "rm", &net]).output();
            return Err(format!("Failed to attach instance to proxy network: {stderr}"));
        }
    }

    // Run the nginx container
    let nginx_name = nginx_container_name(&exposure_id);
    let port_bind = format!("0.0.0.0:{ext_port}:{ext_port}");
    let conf_mount = format!("{}:/etc/nginx/nginx.conf:ro", docker_vol_path(&conf_path));
    let certs_mount = format!("{work_dir_docker}:/etc/nginx/certs:ro");

    let out = docker_cmd(app)
        .args([
            "run", "-d",
            "--name", &nginx_name,
            "--restart", "unless-stopped",
            "--network", &net,
            "-p", &port_bind,
            "-v", &conf_mount,
            "-v", &certs_mount,
            "--label", &format!("app.securedbmanager.exposure_id={exposure_id}"),
            "--label", &format!("app.securedbmanager.instance_id={}", instance.id),
            "nginx:alpine",
        ])
        .output()
        .map_err(|e| format!("docker run failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let _ = docker_cmd(app)
            .args(["network", "disconnect", &net, &instance.container_name])
            .output();
        let _ = docker_cmd(app).args(["network", "rm", &net]).output();
        return Err(format!("Failed to start nginx container: {stderr}"));
    }

    let endpoint = format!("https://{ip}:{ext_port}");
    let exposure = Exposure {
        id: exposure_id,
        instance_id: instance.id.clone(),
        method: "nginx".into(),
        status: "active".into(),
        external_endpoint: Some(endpoint),
        external_port: Some(ext_port),
        provider_id: None,
        pid: None,
        hostname: None,
        error: None,
        firewall_rule_name: None,
        created_at: now(),
        updated_at: now(),
    };
    save_exposure(app, &exposure)?;
    Ok(exposure)
}

async fn teardown_nginx(app: &AppHandle, exposure: &Exposure) -> Result<(), String> {
    let nginx_name = nginx_container_name(&exposure.id);
    let net = direct_network_name(&exposure.id);

    let _ = docker_cmd(app).args(["stop", &nginx_name]).output();
    let _ = docker_cmd(app).args(["rm", "-f", &nginx_name]).output();

    if let Ok(instance) = find_instance(app, &exposure.instance_id) {
        let _ = docker_cmd(app)
            .args(["network", "disconnect", &net, &instance.container_name])
            .output();
    }
    let _ = docker_cmd(app).args(["network", "rm", &net]).output();

    // Clean up certs + config
    let work_dir = nginx_work_dir(&exposure.id);
    let _ = std::fs::remove_dir_all(&work_dir);
    Ok(())
}

async fn teardown_child(app: &AppHandle, exposure: &Exposure) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    let child_opt = state.exposure_children.lock().unwrap().remove(&exposure.id);
    if let Some(mut child) = child_opt {
        let _ = child.kill();
        let _ = child.wait();
    } else if let Some(pid) = exposure.pid {
        // App restarted — fall back to OS-level kill by PID
        kill_by_pid(pid);
    }
    Ok(())
}

fn kill_by_pid(pid: u32) {
    if cfg!(target_os = "windows") {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output();
    } else {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
}

// ── Output scraping helpers ────────────────────────────────────────────────

async fn read_url_from_child_stderr(
    child: &mut std::process::Child,
    needle: &str,
    timeout_secs: u64,
) -> Option<String> {
    use std::io::{BufRead, BufReader};
    use std::time::Instant;
    use tokio::time::{sleep, Duration};

    let stderr = child.stderr.take()?;
    let mut reader = BufReader::new(stderr);
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);

    // Cheap polling loop — read one line at a time on a worker thread, with a
    // wall-clock deadline. This avoids pulling in a heavier async-IO stack.
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(None);
                    return;
                }
                Ok(_) => {
                    if tx.send(Some(line.clone())).is_err() {
                        return;
                    }
                }
                Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
            }
        }
    });

    while Instant::now() < deadline {
        match rx.try_recv() {
            Ok(Some(line)) => {
                if let Some(url) = extract_url_with(&line, needle) {
                    return Some(url);
                }
            }
            Ok(None) => return None,
            Err(_) => {
                sleep(Duration::from_millis(250)).await;
            }
        }
    }
    None
}

fn extract_url_with(line: &str, needle: &str) -> Option<String> {
    // Find an https://...needle... fragment in the line
    let hay = line;
    let start = hay.find("https://")?;
    let tail = &hay[start..];
    if !tail.contains(needle) {
        return None;
    }
    let end = tail
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"')
        .unwrap_or(tail.len());
    Some(tail[..end].trim_end_matches(&['.', ',', ')'][..]).to_string())
}

async fn poll_ngrok_api(max_secs: u64) -> Option<String> {
    use tokio::time::{sleep, Duration};
    for _ in 0..max_secs {
        sleep(Duration::from_secs(1)).await;
        if let Ok(out) = TokioCommand::new(if cfg!(target_os = "windows") {
            "powershell"
        } else {
            "curl"
        })
        .args(if cfg!(target_os = "windows") {
            vec![
                "-NoProfile",
                "-Command",
                "(Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:4040/api/tunnels).Content",
            ]
        } else {
            vec!["-s", "http://127.0.0.1:4040/api/tunnels"]
        })
        .output()
        .await
        {
            if !out.status.success() {
                continue;
            }
            let body = String::from_utf8_lossy(&out.stdout);
            if let Some(url) = parse_ngrok_public_url(&body) {
                return Some(url);
            }
        }
    }
    None
}

fn parse_ngrok_public_url(body: &str) -> Option<String> {
    // Cheap extraction without pulling serde_json dynamics — the field name is
    // "public_url":"tcp://..."
    let key = "\"public_url\":\"";
    let start = body.find(key)?;
    let tail = &body[start + key.len()..];
    let end = tail.find('"')?;
    let url = &tail[..end];
    if url.is_empty() {
        return None;
    }
    Some(url.to_string())
}
