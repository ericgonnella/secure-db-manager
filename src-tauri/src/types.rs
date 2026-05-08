use serde::{Deserialize, Serialize};

/// Docker execution mode detected at startup.
/// Defined here (not in `commands::docker`) so the server binary can use it
/// without dragging in the Tauri command infrastructure.
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
