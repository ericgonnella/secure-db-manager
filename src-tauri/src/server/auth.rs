//! JWT authentication: login route + extractor for protected handlers.

use axum::{
    extract::{FromRequestParts, State},
    http::{request::Parts, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use super::state::ServerState;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
}

#[derive(Debug, Deserialize)]
pub struct LoginInput {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct LoginOutput {
    pub token: String,
    /// Seconds until the token expires.
    pub expires_in: i64,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// `POST /api/auth/login` — exchange admin credentials for a JWT.
pub async fn login(
    State(state): State<ServerState>,
    Json(input): Json<LoginInput>,
) -> Result<Json<LoginOutput>, (StatusCode, Json<ErrorBody>)> {
    if input.username != "admin" {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                error: "invalid credentials".into(),
            }),
        ));
    }
    let ok = bcrypt::verify(&input.password, &state.admin_password_hash).unwrap_or(false);
    if !ok {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                error: "invalid credentials".into(),
            }),
        ));
    }
    let exp_secs = state.token_expiry_hours * 3600;
    let exp = (Utc::now() + Duration::hours(state.token_expiry_hours)).timestamp() as usize;
    let claims = Claims {
        sub: "admin".into(),
        exp,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    )
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                error: format!("token encode: {e}"),
            }),
        )
    })?;
    Ok(Json(LoginOutput {
        token,
        expires_in: exp_secs,
    }))
}

/// `POST /api/auth/logout` — stateless: client just drops the token.
pub async fn logout() -> impl IntoResponse {
    (StatusCode::NO_CONTENT, ())
}

/// Axum extractor — present on every protected handler. Decodes the
/// `Authorization: Bearer <jwt>` header and validates the signature + expiry.
pub struct AuthenticatedUser {
    pub username: String,
}

impl<S> FromRequestParts<S> for AuthenticatedUser
where
    ServerState: axum::extract::FromRef<S>,
    S: Send + Sync,
{
    type Rejection = (StatusCode, Json<ErrorBody>);

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let server_state = <ServerState as axum::extract::FromRef<S>>::from_ref(state);
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| {
                (
                    StatusCode::UNAUTHORIZED,
                    Json(ErrorBody {
                        error: "missing Authorization header".into(),
                    }),
                )
            })?;
        let token = header.strip_prefix("Bearer ").ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(ErrorBody {
                    error: "expected `Bearer <token>`".into(),
                }),
            )
        })?;
        let data = decode::<Claims>(
            token,
            &DecodingKey::from_secret(server_state.jwt_secret.as_bytes()),
            &Validation::default(),
        )
        .map_err(|e| {
            (
                StatusCode::UNAUTHORIZED,
                Json(ErrorBody {
                    error: format!("invalid token: {e}"),
                }),
            )
        })?;
        Ok(AuthenticatedUser {
            username: data.claims.sub,
        })
    }
}
