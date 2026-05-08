//! Mode-agnostic event emitter.
//!
//! On desktop, events are pushed to the React frontend via Tauri's
//! `app.emit(...)`. On the server, the same events are broadcast over an
//! SSE channel to all connected browsers. Command implementations only see
//! the [`EventEmitter`] trait so they don't care which transport is active.

use serde::Serialize;
use std::sync::Arc;

/// Anything that can deliver a JSON-serialisable payload to subscribers
/// listening on a named channel.
pub trait EventEmitter: Send + Sync {
    /// Emit `payload` on the named channel. Implementations must not block
    /// or panic — events are best-effort and dropping one is preferable to
    /// stalling the caller.
    fn emit_json(&self, channel: &str, payload: serde_json::Value);
}

/// Helper that handles the `serde_json::to_value` step so call-sites stay
/// concise.
pub fn emit<E: EventEmitter + ?Sized, T: Serialize>(emitter: &E, channel: &str, payload: &T) {
    if let Ok(value) = serde_json::to_value(payload) {
        emitter.emit_json(channel, value);
    }
}

/// `EventEmitter` backed by a Tauri `AppHandle`. Dispatches via
/// `tauri::Emitter::emit`.
pub struct TauriEmitter {
    pub app: tauri::AppHandle,
}

impl EventEmitter for TauriEmitter {
    fn emit_json(&self, channel: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.app.emit(channel, payload);
    }
}

/// Convenience type alias for an owned, shared, dyn-dispatched emitter
/// suitable for stashing inside `AppContext` once Phase 2 wires it up.
#[allow(dead_code)]
pub type SharedEmitter = Arc<dyn EventEmitter>;
