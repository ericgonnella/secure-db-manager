//! Mode-agnostic application context.
//!
//! Both the Tauri desktop binary and the headless `baseport-server` HTTP binary
//! build an `AppContext` from their respective state and pass it to the shared
//! `_impl` business-logic functions. This is what allows a single Rust code
//! path to back both modes without duplication.
//!
//! The struct holds only `Arc`-wrapped handles so cloning it is cheap — Axum
//! handlers receive a fresh clone for every request.

use crate::types::DockerMode;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Shared, cheaply-cloneable handle to all per-process state needed by
/// command implementations.
#[derive(Clone)]
pub struct AppContext {
    /// Directory holding `local_store.json`, secrets file, audit log, backups.
    /// Resolved from the Tauri app data dir on desktop, or `BASEPORT_DATA_DIR`
    /// on the server.
    pub data_dir: PathBuf,
    /// Cached Docker execution mode (Native / WSL2 / None).
    pub docker_mode: Arc<Mutex<DockerMode>>,
    /// Long-running child processes (cloudflared, ngrok) keyed by exposure id.
    pub exposure_children: Arc<Mutex<HashMap<String, std::process::Child>>>,
}

impl AppContext {
    /// Build an `AppContext` directly from raw parts. Used by the HTTP server
    /// binary at startup.
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            docker_mode: Arc::new(Mutex::new(DockerMode::None)),
            exposure_children: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Build an `AppContext` from a Tauri `AppHandle`. We share the same `Arc`s
/// that live inside the Tauri-managed `AppState` so both code paths see the
/// same Docker-mode cache and child-process registry.
#[cfg(feature = "desktop")]
impl From<&tauri::AppHandle> for AppContext {
    fn from(app: &tauri::AppHandle) -> Self {
        use tauri::Manager;
        let state = app.state::<crate::AppState>();
        let data_dir = app
            .path()
            .app_data_dir()
            .expect("Could not resolve app data directory");
        // Make sure the directory exists; downstream code assumes this.
        let _ = std::fs::create_dir_all(&data_dir);
        Self {
            data_dir,
            docker_mode: state.docker_mode.clone(),
            exposure_children: state.exposure_children.clone(),
        }
    }
}
