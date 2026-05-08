//! Per-process state shared by every Axum handler.

use crate::AppContext;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::broadcast;

use super::config::ServerConfig;

/// SSE event published to all connected browsers. The string payload is a
/// pre-serialised JSON value, mirroring how Tauri events flow today.
#[derive(Clone, Debug)]
pub struct ServerEvent {
    pub channel: String,
    pub payload: String,
}

#[derive(Clone)]
pub struct ServerState {
    pub ctx: AppContext,
    pub jwt_secret: Arc<String>,
    pub admin_password_hash: Arc<String>,
    pub token_expiry_hours: i64,
    pub allowed_origin: Option<String>,
    pub bind_addr: SocketAddr,
    pub sse_tx: broadcast::Sender<ServerEvent>,
}

impl ServerState {
    pub fn from_config(config: ServerConfig) -> Result<Self, String> {
        let admin_password_hash = bcrypt::hash(&config.admin_password, bcrypt::DEFAULT_COST)
            .map_err(|e| format!("bcrypt hash failed: {e}"))?;
        let bind_addr = config.bind_address();
        let (sse_tx, _) = broadcast::channel(256);

        Ok(Self {
            ctx: AppContext::new(config.data_dir),
            jwt_secret: Arc::new(config.jwt_secret),
            admin_password_hash: Arc::new(admin_password_hash),
            token_expiry_hours: config.token_expiry_hours,
            allowed_origin: config.allowed_origin,
            bind_addr,
            sse_tx,
        })
    }

    pub fn bind_address(&self) -> SocketAddr {
        self.bind_addr
    }
}
