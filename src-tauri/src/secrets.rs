//! Pluggable secret-storage backend.
//!
//! The desktop binary uses the OS keyring (Windows Credential Manager,
//! macOS Keychain, libsecret on Linux). The headless server binary running
//! on a VPS has no usable system keyring, so it stores secrets in an
//! AES-256-GCM encrypted file under the data directory. The encryption key
//! comes from the `BASEPORT_SECRET_KEY` environment variable.
//!
//! Both backends expose the same API: `store(account, password)`,
//! `read(account)`, `read_opt(account)`, `forget(account)`.
//!
//! The active backend is selected once at startup via [`configure`] and
//! cannot be changed afterwards.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub const KEYRING_SERVICE: &str = "com.ericg.baseport";

/// Which storage backend the running process should use.
#[derive(Clone, Debug)]
pub enum SecretBackend {
    /// OS-native keyring. Used by the desktop Tauri binary.
    Keyring,
    /// AES-256-GCM encrypted file at `<data_dir>/secrets.bin`.
    /// Used by the `baseport-server` HTTP binary on a VPS where no
    /// system keyring is available. The key is the raw 32-byte master key
    /// (typically derived from `BASEPORT_SECRET_KEY`).
    EncryptedFile { data_dir: PathBuf, key: [u8; 32] },
}

static BACKEND: OnceLock<SecretBackend> = OnceLock::new();

/// In-memory cache for the encrypted-file backend so we don't re-decrypt
/// the whole file on every read. Populated on first access; mutations
/// rewrite the file under this lock.
static FILE_CACHE: OnceLock<Mutex<Option<HashMap<String, String>>>> = OnceLock::new();

fn file_cache() -> &'static Mutex<Option<HashMap<String, String>>> {
    FILE_CACHE.get_or_init(|| Mutex::new(None))
}

/// Install the secret backend for this process. Idempotent — the second
/// and subsequent calls are silently ignored, matching `OnceLock` semantics.
pub fn configure(backend: SecretBackend) {
    let _ = BACKEND.set(backend);
}

fn backend() -> &'static SecretBackend {
    BACKEND.get_or_init(|| SecretBackend::Keyring)
}

// ── Public API ─────────────────────────────────────────────────────────────

pub fn store(account: &str, password: &str) -> Result<(), String> {
    match backend() {
        SecretBackend::Keyring => keyring_store(account, password),
        SecretBackend::EncryptedFile { data_dir, key } => {
            file_store(data_dir, key, account, password)
        }
    }
}

pub fn read(account: &str) -> Result<String, String> {
    read_opt(account)?.ok_or_else(|| "CREDENTIAL_NOT_FOUND".to_string())
}

pub fn read_opt(account: &str) -> Result<Option<String>, String> {
    match backend() {
        SecretBackend::Keyring => keyring_read_opt(account),
        SecretBackend::EncryptedFile { data_dir, key } => file_read_opt(data_dir, key, account),
    }
}

pub fn forget(account: &str) {
    match backend() {
        SecretBackend::Keyring => keyring_forget(account),
        SecretBackend::EncryptedFile { data_dir, key } => {
            let _ = file_forget(data_dir, key, account);
        }
    }
}

// ── Keyring backend ────────────────────────────────────────────────────────

fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account)
        .map_err(|e| format!("Failed to access OS keyring: {e}"))
}

fn keyring_store(account: &str, password: &str) -> Result<(), String> {
    keyring_entry(account)?
        .set_password(password)
        .map_err(|e| format!("Failed to save password to keyring: {e}"))
}

fn keyring_read_opt(account: &str) -> Result<Option<String>, String> {
    match keyring_entry(account)?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to read password from keyring: {e}")),
    }
}

fn keyring_forget(account: &str) {
    if let Ok(entry) = keyring_entry(account) {
        // Best-effort delete; ignore errors (entry may not exist).
        let _ = entry.delete_credential();
    }
}

// ── Encrypted-file backend ─────────────────────────────────────────────────
//
// File layout (`<data_dir>/secrets.bin`):
//   bytes  0..12  : random nonce (96-bit, freshly generated on every write)
//   bytes 12..    : ciphertext + 16-byte GCM auth tag
//
// The plaintext is `serde_json::to_vec(&HashMap<String,String>)`.
//
// AES-256-GCM rotates the nonce on every write so even identical plaintexts
// produce different ciphertexts. We use the cache to avoid re-reading and
// re-decrypting on every operation.

#[cfg(feature = "server")]
const NONCE_LEN: usize = 12;

#[cfg(feature = "server")]
fn secrets_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join("secrets.bin")
}

#[cfg(feature = "server")]
fn load_file_map(data_dir: &Path, key: &[u8; 32]) -> Result<HashMap<String, String>, String> {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};

    let path = secrets_file_path(data_dir);
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read secrets file: {e}"))?;
    if bytes.len() < NONCE_LEN + 16 {
        return Err("secrets file is corrupt (too short)".into());
    }
    let (nonce_bytes, ct) = bytes.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("invalid key: {e}"))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ct)
        .map_err(|_| "failed to decrypt secrets file (wrong key?)".to_string())?;
    let map: HashMap<String, String> =
        serde_json::from_slice(&plaintext).map_err(|e| format!("decode secrets: {e}"))?;
    Ok(map)
}

#[cfg(feature = "server")]
fn save_file_map(
    data_dir: &Path,
    key: &[u8; 32],
    map: &HashMap<String, String>,
) -> Result<(), String> {
    use aes_gcm::aead::{Aead, OsRng};
    use aes_gcm::{AeadCore, Aes256Gcm, KeyInit};

    let plaintext = serde_json::to_vec(map).map_err(|e| format!("encode secrets: {e}"))?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("invalid key: {e}"))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, plaintext.as_ref())
        .map_err(|e| format!("encrypt secrets: {e}"))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    std::fs::create_dir_all(data_dir).map_err(|e| format!("create data dir: {e}"))?;
    std::fs::write(secrets_file_path(data_dir), out)
        .map_err(|e| format!("write secrets file: {e}"))?;
    Ok(())
}

#[cfg(feature = "server")]
fn with_file_map<R>(
    data_dir: &Path,
    key: &[u8; 32],
    f: impl FnOnce(&mut HashMap<String, String>) -> Result<R, String>,
    write_back: bool,
) -> Result<R, String> {
    let mut guard = file_cache().lock().map_err(|_| "secrets cache poisoned")?;
    if guard.is_none() {
        *guard = Some(load_file_map(data_dir, key)?);
    }
    let map = guard.as_mut().expect("just initialised");
    let result = f(map)?;
    if write_back {
        save_file_map(data_dir, key, map)?;
    }
    Ok(result)
}

#[cfg(feature = "server")]
fn file_store(data_dir: &Path, key: &[u8; 32], account: &str, password: &str) -> Result<(), String> {
    with_file_map(
        data_dir,
        key,
        |map| {
            map.insert(account.to_string(), password.to_string());
            Ok(())
        },
        true,
    )
}

#[cfg(feature = "server")]
fn file_read_opt(data_dir: &Path, key: &[u8; 32], account: &str) -> Result<Option<String>, String> {
    with_file_map(data_dir, key, |map| Ok(map.get(account).cloned()), false)
}

#[cfg(feature = "server")]
fn file_forget(data_dir: &Path, key: &[u8; 32], account: &str) -> Result<(), String> {
    with_file_map(
        data_dir,
        key,
        |map| {
            map.remove(account);
            Ok(())
        },
        true,
    )
}

// When the `server` feature is OFF, the desktop build never instantiates the
// `EncryptedFile` variant, but the match arms in `store`/`read_opt`/`forget`
// must still compile. Provide stub error returns.
#[cfg(not(feature = "server"))]
fn file_store(_d: &Path, _k: &[u8; 32], _a: &str, _p: &str) -> Result<(), String> {
    Err("Encrypted-file backend requires the `server` feature".into())
}
#[cfg(not(feature = "server"))]
fn file_read_opt(_d: &Path, _k: &[u8; 32], _a: &str) -> Result<Option<String>, String> {
    Err("Encrypted-file backend requires the `server` feature".into())
}
#[cfg(not(feature = "server"))]
fn file_forget(_d: &Path, _k: &[u8; 32], _a: &str) -> Result<(), String> {
    Err("Encrypted-file backend requires the `server` feature".into())
}
