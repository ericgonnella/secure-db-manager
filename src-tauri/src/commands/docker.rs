use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename_all = "snake_case")]
pub enum DockerMode {
    /// docker CLI is in PATH (Docker Desktop or native Linux/macOS install)
    Native,
    /// docker is only available via WSL2 (no Docker Desktop required)
    Wsl2,
    /// Docker not found anywhere
    None,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SetupStep {
    pub text: String,
    pub code: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DockerStatus {
    pub cli_available: bool,
    pub cli_version: Option<String>,
    pub daemon_running: bool,
    pub daemon_error: Option<String>,
    pub mode: DockerMode,
    pub setup_steps: Vec<SetupStep>,
}

// ── Detection helpers ──────────────────────────────────────────────────────

fn try_native_docker_version() -> Option<String> {
    Command::new("docker")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn try_wsl_docker_version() -> Option<String> {
    // Only attempt WSL2 path on Windows
    if !cfg!(target_os = "windows") {
        return None;
    }
    Command::new("wsl")
        .args(["docker", "--version"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn check_native_daemon() -> (bool, Option<String>) {
    match Command::new("docker").arg("info").output() {
        Ok(o) if o.status.success() => (true, None),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
            let msg = if stderr.contains("permission denied") {
                "Permission denied — add your user to the docker group.".to_string()
            } else {
                "Docker daemon is not running.".to_string()
            };
            (false, Some(msg))
        }
        Err(e) => (false, Some(format!("Cannot reach Docker daemon: {e}"))),
    }
}

fn check_wsl_daemon() -> (bool, Option<String>) {
    match Command::new("wsl").args(["docker", "info"]).output() {
        Ok(o) if o.status.success() => (true, None),
        _ => (
            false,
            Some("Docker daemon is not running inside WSL2.".to_string()),
        ),
    }
}

// ── Shared baseport-net network ────────────────────────────────────────────

/// Name of the shared bridge network used so DB instances and web apps
/// can reach each other by container name (e.g. http://bp_my_pb_pocketbase:8090).
pub const BASEPORT_NETWORK: &str = "baseport-net";

/// Build a `Command` for the current docker mode (native vs WSL2).
pub fn build_docker_command(mode: &DockerMode) -> Command {
    match mode {
        DockerMode::Wsl2 => {
            let mut cmd = Command::new("wsl");
            cmd.arg("docker");
            cmd
        }
        _ => Command::new("docker"),
    }
}

/// Idempotently create the shared `baseport-net` bridge network.
/// Returns Ok if the network exists or was created. Errors only on real failures.
pub fn ensure_baseport_network(mode: &DockerMode) -> Result<(), String> {
    // Quick check: does it already exist?
    let inspect = build_docker_command(mode)
        .args(["network", "inspect", BASEPORT_NETWORK])
        .output();
    if let Ok(o) = inspect {
        if o.status.success() {
            return Ok(());
        }
    }
    let out = build_docker_command(mode)
        .args(["network", "create", "--driver", "bridge", BASEPORT_NETWORK])
        .output()
        .map_err(|e| format!("Failed to run docker network create: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    // Race condition tolerance: another process may have created it concurrently.
    if stderr.contains("already exists") {
        return Ok(());
    }
    Err(format!("Failed to create {BASEPORT_NETWORK}: {stderr}"))
}

/// Idempotently connect a container to the shared `baseport-net` network.
/// Treats "already exists in network" as success.
pub fn connect_container_to_network(mode: &DockerMode, container: &str) -> Result<(), String> {
    let out = build_docker_command(mode)
        .args(["network", "connect", BASEPORT_NETWORK, container])
        .output()
        .map_err(|e| format!("Failed to run docker network connect: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("already exists in network") || stderr.contains("is already") {
        return Ok(());
    }
    Err(format!(
        "Failed to connect {container} to {BASEPORT_NETWORK}: {stderr}"
    ))
}

// ── Setup step builders ────────────────────────────────────────────────────

fn step(text: &str, code: Option<&str>) -> SetupStep {
    SetupStep {
        text: text.to_string(),
        code: code.map(|s| s.to_string()),
    }
}

fn wsl_install_steps() -> Vec<SetupStep> {
    vec![
        step("Open PowerShell as Administrator and install WSL2 with Ubuntu:", Some("wsl --install -d Ubuntu")),
        step("Restart your computer, then open the Ubuntu app from the Start Menu.", None),
        step("Inside the Ubuntu terminal, install Docker Engine:", Some("curl -fsSL https://get.docker.com | sh")),
        step("Add your user to the docker group:", Some("sudo usermod -aG docker $USER")),
        step("Enable systemd so Docker starts automatically — add this to /etc/wsl.conf:", Some("[boot]\nsystemd=true")),
        step("Enable and start Docker:", Some("sudo systemctl enable --now docker")),
        step("Restart WSL2 from PowerShell, then reopen Ubuntu:", Some("wsl --shutdown")),
        step("Reopen this app — Docker should now be detected automatically.", None),
    ]
}

fn wsl_daemon_start_steps() -> Vec<SetupStep> {
    vec![
        step("Docker Engine is installed in WSL2 but the daemon is not running.", None),
        step("Open your WSL2 Ubuntu terminal and start Docker:", Some("sudo service docker start")),
        step("For automatic startup on WSL2 launch, add this to /etc/wsl.conf in Ubuntu:", Some("[boot]\nsystemd=true")),
        step("Then enable Docker as a systemd service:", Some("sudo systemctl enable --now docker")),
        step("Restart WSL2 to apply:", Some("wsl --shutdown")),
    ]
}

fn native_daemon_start_steps() -> Vec<SetupStep> {
    vec![
        step("Docker CLI is installed but the daemon is not running.", None),
        step(
            "If using Docker Desktop: open it from the Start Menu or system tray.",
            None,
        ),
        step(
            "If using WSL2 Docker Engine: open your Ubuntu terminal and run:",
            Some("sudo service docker start"),
        ),
        step(
            "For automatic startup, enable systemd in /etc/wsl.conf and run:",
            Some("sudo systemctl enable --now docker"),
        ),
    ]
}

// ── Main command ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn detect_docker(
    state: tauri::State<'_, crate::AppState>,
) -> Result<DockerStatus, String> {
    // 1. Native docker CLI in PATH
    if let Some(version) = try_native_docker_version() {
        let (daemon_running, daemon_error) = check_native_daemon();
        let setup_steps = if daemon_running {
            vec![]
        } else {
            native_daemon_start_steps()
        };
        let mode = DockerMode::Native;
        *state.docker_mode.lock().unwrap() = mode.clone();
        // Best-effort: ensure shared bridge network exists for instance/web-app
        // inter-container DNS. Failures are non-fatal at detection time.
        if daemon_running {
            let _ = ensure_baseport_network(&mode);
        }
        return Ok(DockerStatus {
            cli_available: true,
            cli_version: Some(version),
            daemon_running,
            daemon_error,
            mode,
            setup_steps,
        });
    }

    // 2. Docker available via WSL2 (Windows without Docker Desktop)
    if let Some(version) = try_wsl_docker_version() {
        let (daemon_running, daemon_error) = check_wsl_daemon();
        let setup_steps = if daemon_running {
            vec![]
        } else {
            wsl_daemon_start_steps()
        };
        let mode = DockerMode::Wsl2;
        *state.docker_mode.lock().unwrap() = mode.clone();
        if daemon_running {
            let _ = ensure_baseport_network(&mode);
        }
        return Ok(DockerStatus {
            cli_available: true,
            cli_version: Some(version),
            daemon_running,
            daemon_error,
            mode,
            setup_steps,
        });
    }

    // 3. Docker not found anywhere
    *state.docker_mode.lock().unwrap() = DockerMode::None;
    Ok(DockerStatus {
        cli_available: false,
        cli_version: None,
        daemon_running: false,
        daemon_error: Some("Docker not found.".to_string()),
        mode: DockerMode::None,
        setup_steps: wsl_install_steps(),
    })
}

