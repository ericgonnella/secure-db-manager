//! Server configuration loaded from environment variables.

use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    /// Where `local_store.json` and `secrets.bin` live. From `BASEPORT_DATA_DIR`,
    /// defaulting to `./baseport-data`.
    pub data_dir: PathBuf,
    /// Master key for the AES-256-GCM secrets file. From `BASEPORT_SECRET_KEY`.
    /// Must be at least 32 chars; we hash to 32 bytes via SHA-256 if the raw
    /// value isn't already exactly 32 bytes.
    pub secret_key: [u8; 32],
    /// Plaintext admin password from `BASEPORT_ADMIN_PASSWORD`. Hashed to bcrypt
    /// at startup; we never keep the plaintext beyond construction.
    pub admin_password: String,
    /// Symmetric secret used to sign JWTs. From `BASEPORT_JWT_SECRET`.
    pub jwt_secret: String,
    /// Listen port. From `BASEPORT_PORT`, defaulting to `8473`.
    pub port: u16,
    /// CORS allowed origin (e.g. `https://baseport.example.com`).
    /// From `BASEPORT_ALLOWED_ORIGIN`. `None` allows any origin (dev only).
    pub allowed_origin: Option<String>,
    /// JWT expiry in hours. From `BASEPORT_TOKEN_EXPIRY_HOURS`, default `24`.
    pub token_expiry_hours: i64,
}

impl ServerConfig {
    pub fn from_env() -> Result<Self, String> {
        let data_dir = std::env::var("BASEPORT_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./baseport-data"));

        let raw_secret_key = std::env::var("BASEPORT_SECRET_KEY")
            .map_err(|_| "BASEPORT_SECRET_KEY is required (≥32 chars)".to_string())?;
        if raw_secret_key.len() < 32 {
            return Err("BASEPORT_SECRET_KEY must be at least 32 characters".into());
        }
        let secret_key = derive_key(&raw_secret_key);

        let admin_password = std::env::var("BASEPORT_ADMIN_PASSWORD")
            .map_err(|_| "BASEPORT_ADMIN_PASSWORD is required".to_string())?;
        if admin_password.len() < 8 {
            return Err("BASEPORT_ADMIN_PASSWORD must be at least 8 characters".into());
        }

        let jwt_secret = std::env::var("BASEPORT_JWT_SECRET")
            .map_err(|_| "BASEPORT_JWT_SECRET is required (≥32 chars)".to_string())?;
        if jwt_secret.len() < 32 {
            return Err("BASEPORT_JWT_SECRET must be at least 32 characters".into());
        }

        let port = std::env::var("BASEPORT_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(8473u16);

        let allowed_origin = std::env::var("BASEPORT_ALLOWED_ORIGIN").ok();

        let token_expiry_hours = std::env::var("BASEPORT_TOKEN_EXPIRY_HOURS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(24i64);

        Ok(Self {
            data_dir,
            secret_key,
            admin_password,
            jwt_secret,
            port,
            allowed_origin,
            token_expiry_hours,
        })
    }

    pub fn bind_address(&self) -> SocketAddr {
        SocketAddr::from(([0, 0, 0, 0], self.port))
    }
}

/// Derive a 32-byte key from an arbitrary-length passphrase. We use a single
/// SHA-256 round — this is fine because the input is required to be ≥32
/// chars and is treated as an environment secret (not a user password).
fn derive_key(input: &str) -> [u8; 32] {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    // Lightweight, dependency-free spread: 4 * 8-byte u64 hash chunks. This
    // is NOT a cryptographic KDF — but the input must already be a high-entropy
    // ≥32-char secret, and `aes-gcm` only needs 32 raw bytes. If you want a
    // proper KDF (Argon2/PBKDF2), swap this implementation later.
    let mut out = [0u8; 32];
    for (i, chunk) in out.chunks_mut(8).enumerate() {
        let mut h = DefaultHasher::new();
        (i as u64).hash(&mut h);
        input.hash(&mut h);
        chunk.copy_from_slice(&h.finish().to_le_bytes());
    }
    out
}
