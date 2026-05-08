//! HTTP route handlers.
//!
//! V1 SCOPE: For the initial server release we expose the read-mostly
//! endpoints needed to log in and inspect the deployment. The more
//! disruptive commands (start/stop/delete instances, exposures, web-app
//! deployment, etc.) are reachable from the desktop app today and will be
//! added to the HTTP surface in follow-up commits as we extract `_impl`
//! functions from the Tauri command modules. The router below is shaped so
//! adding a new route is a one-liner.
//!
//! Every route except `/api/auth/login` requires a valid JWT.

use axum::{
    extract::State,
    http::{HeaderValue, Method, StatusCode},
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::local_store::{load_store_at, AuditEvent, LocalInstance, RemoteHost};

use super::auth::{login, logout, AuthenticatedUser, ErrorBody};
use super::events::sse_handler;
use super::state::ServerState;

fn err(status: StatusCode, msg: impl Into<String>) -> (StatusCode, Json<ErrorBody>) {
    (status, Json(ErrorBody { error: msg.into() }))
}

// ── Read-only handlers ─────────────────────────────────────────────────────

async fn list_local_instances(
    _user: AuthenticatedUser,
    State(state): State<ServerState>,
) -> Json<Vec<LocalInstance>> {
    Json(load_store_at(&state.ctx.data_dir).instances)
}

async fn list_remote_hosts(
    _user: AuthenticatedUser,
    State(state): State<ServerState>,
) -> Json<Vec<RemoteHost>> {
    Json(load_store_at(&state.ctx.data_dir).remote_hosts)
}

async fn list_audit_logs(
    _user: AuthenticatedUser,
    State(state): State<ServerState>,
) -> Json<Vec<AuditEvent>> {
    Json(load_store_at(&state.ctx.data_dir).audit_log)
}

async fn list_exposures(
    _user: AuthenticatedUser,
    State(state): State<ServerState>,
) -> Json<Vec<crate::local_store::Exposure>> {
    Json(load_store_at(&state.ctx.data_dir).exposures)
}

async fn list_web_apps(
    _user: AuthenticatedUser,
    State(state): State<ServerState>,
) -> Json<Vec<crate::local_store::WebApp>> {
    Json(load_store_at(&state.ctx.data_dir).web_apps)
}

async fn list_backups(
    _user: AuthenticatedUser,
    State(state): State<ServerState>,
) -> Json<Vec<crate::local_store::BackupRecord>> {
    Json(load_store_at(&state.ctx.data_dir).backups)
}

async fn get_data_dir(
    _user: AuthenticatedUser,
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "data_dir": state.ctx.data_dir.to_string_lossy(),
    }))
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn whoami(user: AuthenticatedUser) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "username": user.username }))
}

// Placeholder for not-yet-implemented mutating routes. Returns 501 so the
// frontend can show a friendly "this action is desktop-only for now" hint.
async fn not_implemented() -> (StatusCode, Json<ErrorBody>) {
    err(
        StatusCode::NOT_IMPLEMENTED,
        "this endpoint is not yet exposed in server mode",
    )
}

// ── Router ─────────────────────────────────────────────────────────────────

pub fn router(state: ServerState) -> Router {
    let cors = match &state.allowed_origin {
        Some(origin) => CorsLayer::new()
            .allow_origin(AllowOrigin::exact(
                HeaderValue::from_str(origin).expect("invalid BASEPORT_ALLOWED_ORIGIN"),
            ))
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers([
                axum::http::header::AUTHORIZATION,
                axum::http::header::CONTENT_TYPE,
            ])
            .allow_credentials(true),
        None => CorsLayer::permissive(),
    };

    Router::new()
        // Public
        .route("/api/health", get(health))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        // Authenticated reads
        .route("/api/auth/whoami", get(whoami))
        .route("/api/instances", get(list_local_instances))
        .route("/api/hosts", get(list_remote_hosts))
        .route("/api/exposures", get(list_exposures))
        .route("/api/web-apps", get(list_web_apps))
        .route("/api/backups", get(list_backups))
        .route("/api/audit-logs", get(list_audit_logs))
        .route("/api/config/data-dir", get(get_data_dir))
        // Real-time events
        .route("/api/events", get(sse_handler))
        // Mutating routes — reserved, fall through to 501 until each command
        // body is ported. Listing the routes here keeps the surface visible.
        .route("/api/instances", post(not_implemented))
        .route("/api/hosts", post(not_implemented))
        .route("/api/exposures", post(not_implemented))
        .route("/api/web-apps", post(not_implemented))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
