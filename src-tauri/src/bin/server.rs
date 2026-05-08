//! Headless HTTP server binary for VPS / web mode.
//!
//! Build with:  `cargo build --release --bin baseport-server --features server`
//! Run with environment variables (see `server::config::ServerConfig`).

use baseport_lib::server::{self, ServerConfig, ServerState};
use baseport_lib::{secrets, AppContext};
use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    // Initialise tracing first so config-load errors are visible.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,tower_http=info")),
        )
        .init();

    let config = match ServerConfig::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("config error: {e}");
            return ExitCode::from(1);
        }
    };

    // Make sure the data directory exists before any handler tries to use it.
    if let Err(e) = std::fs::create_dir_all(&config.data_dir) {
        eprintln!("could not create data dir {:?}: {e}", config.data_dir);
        return ExitCode::from(1);
    }

    // Install the encrypted-file secrets backend BEFORE building state — the
    // bcrypt hash setup inside `ServerState::from_config` doesn't read secrets
    // but downstream handlers will, and the backend must be locked in before
    // any concurrent handler runs.
    secrets::configure(secrets::SecretBackend::EncryptedFile {
        data_dir: config.data_dir.clone(),
        key: config.secret_key,
    });

    let state = match ServerState::from_config(config) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("state init error: {e}");
            return ExitCode::from(1);
        }
    };

    // Sanity-check that AppContext was wired up correctly.
    let _ = AppContext::clone(&state.ctx);

    if let Err(e) = server::serve(state).await {
        eprintln!("server error: {e}");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}
