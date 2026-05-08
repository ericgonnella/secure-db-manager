//! HTTP server stack for the headless `baseport-server` binary.
//!
//! Only compiled with the `server` feature flag — the desktop Tauri build
//! ignores this module entirely.

pub mod auth;
pub mod config;
pub mod events;
pub mod routes;
pub mod state;

pub use config::ServerConfig;
pub use state::ServerState;

/// Entry point used by `src/bin/server.rs`. Builds the router from a fully
/// initialised `ServerState` and binds to the configured address.
pub async fn serve(state: ServerState) -> Result<(), Box<dyn std::error::Error>> {
    let addr = state.bind_address();
    let app = routes::router(state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("baseport-server listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
