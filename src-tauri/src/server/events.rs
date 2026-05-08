//! Server-Sent Events stream — HTTP equivalent of Tauri's `app.emit`.
//!
//! Browsers connect to `GET /api/events`; the server forwards every
//! [`ServerEvent`] published on the broadcast channel.

use std::convert::Infallible;
use std::time::Duration;

use axum::{
    extract::State,
    response::sse::{Event, KeepAlive, Sse},
};
use futures::stream::Stream;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};

use super::auth::AuthenticatedUser;
use super::state::{ServerEvent, ServerState};

/// `GET /api/events` — long-lived SSE stream, one per browser tab.
pub async fn sse_handler(
    _user: AuthenticatedUser,
    State(state): State<ServerState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.sse_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|res| match res {
        Ok(ev) => Some(Ok(Event::default().event(ev.channel).data(ev.payload))),
        // If the receiver lagged we just drop the missed events; the client
        // can re-fetch state from the REST endpoints if it needs to recover.
        Err(_) => None,
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

/// Convenience for command-impl code: publish a JSON-serialisable event to
/// every connected SSE client. Best-effort — a full channel is silently
/// dropped, matching the desktop `app.emit` semantics.
pub fn publish<T: serde::Serialize>(state: &ServerState, channel: &str, payload: &T) {
    if let Ok(json) = serde_json::to_string(payload) {
        let _ = state.sse_tx.send(ServerEvent {
            channel: channel.to_string(),
            payload: json,
        });
    }
}
