//! Authentication: server-side sessions carried in an HttpOnly cookie, started by a passkey
//! or recovery code sign-in (`accounts.rs`), plus an opt-in development token scheme
//! (`Bearer dev:<user-id>`).

use axum::extract::FromRequestParts;
use axum::http::{header, request::Parts, HeaderMap, HeaderValue};
use cookie::time::Duration;
use cookie::{Cookie, SameSite};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::config::AccountsConfig;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::util::now_ms;

const DAY_MS: i64 = 86_400_000;

pub const SESSION_COOKIE: &str = "folio_session";

/// The authenticated caller. All data access is scoped by `user_id`.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: String,
}

/// Cookie name as the browser sees it. On HTTPS the `__Host-` prefix pins the cookie to this origin.
fn cookie_name(cfg: &AccountsConfig, name: &str) -> String {
    if cfg.secure() {
        format!("__Host-{name}")
    } else {
        name.to_string()
    }
}

/// `Set-Cookie` value for a first-party cookie that scripts can't read.
/// An empty value with a zero `max_age` removes the cookie.
pub fn set_cookie(cfg: &AccountsConfig, name: &str, value: &str, max_age: Duration) -> HeaderValue {
    let cookie = Cookie::build((cookie_name(cfg, name), value))
        .path("/")
        .http_only(true)
        .secure(cfg.secure())
        .same_site(SameSite::Lax)
        .max_age(max_age)
        .build();
    HeaderValue::from_str(&cookie.to_string()).expect("cookie names and values are ASCII")
}

pub fn read_cookie(cfg: &AccountsConfig, headers: &HeaderMap, name: &str) -> Option<String> {
    let name = cookie_name(cfg, name);
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|h| h.to_str().ok())
        .flat_map(Cookie::split_parse)
        .filter_map(Result::ok)
        .find(|c| c.name() == name)
        .map(|c| c.value().to_string())
}

/// Hex SHA-256, how tokens and recovery codes are stored.
pub fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// 256 random bits as hex.
pub fn random_token() -> String {
    hex::encode(rand::random::<[u8; 32]>())
}

/// Starts a session and returns its token, the cookie value.
pub async fn create_session(db: &SqlitePool, user_id: &str, days: i64) -> AppResult<String> {
    let token = random_token();
    let now = now_ms();
    sqlx::query("DELETE FROM sessions WHERE expires_at <= ?")
        .bind(now)
        .execute(db)
        .await?;
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(token_hash(&token))
    .bind(user_id)
    .bind(now)
    .bind(now + days * DAY_MS)
    .execute(db)
    .await?;
    Ok(token)
}

pub async fn delete_session(db: &SqlitePool, token: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
        .bind(token_hash(token))
        .execute(db)
        .await?;
    Ok(())
}

/// The user of a live session. A session lasts `days` from its last use; the stored expiry
/// moves at most once a day to keep writes off the request path.
async fn session_user(db: &SqlitePool, token: &str, days: i64) -> AppResult<Option<String>> {
    let hash = token_hash(token);
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?")
            .bind(&hash)
            .fetch_optional(db)
            .await?;
    let now = now_ms();
    let Some((user_id, expires_at)) = row.filter(|(_, expires_at)| *expires_at > now) else {
        return Ok(None);
    };
    let extended = now + days * DAY_MS;
    if extended - expires_at > DAY_MS {
        sqlx::query("UPDATE sessions SET expires_at = ? WHERE token_hash = ?")
            .bind(extended)
            .bind(&hash)
            .execute(db)
            .await?;
    }
    Ok(Some(user_id))
}

/// The session token and user id behind a browser request, if its cookie names a live session.
pub async fn browser_session(
    state: &AppState,
    headers: &HeaderMap,
) -> AppResult<Option<(String, String)>> {
    let Some(cfg) = &state.config.accounts else {
        return Ok(None);
    };
    let Some(token) = read_cookie(cfg, headers, SESSION_COOKIE) else {
        return Ok(None);
    };
    let user_id = session_user(&state.db, &token, state.config.session_days).await?;
    Ok(user_id.map(|user_id| (token, user_id)))
}

/// User ids end up in object keys / logs; keep them boring.
fn valid_user_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:@".contains(&b))
}

/// Cookie-authenticated writes and sign-ins must come from the app's own origin.
/// `SameSite=Lax` already keeps the cookie off cross-site writes; comparing the origin also
/// stops other sites under the same registrable domain.
pub fn require_own_origin(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    let origin = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok());
    let own = state
        .config
        .accounts
        .as_ref()
        .map(|a| a.public_origin.as_str());
    if origin.is_some() && origin == own {
        Ok(())
    } else {
        Err(AppError::Unauthorized(
            "request comes from another origin".into(),
        ))
    }
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let bad = |m: &str| AppError::Unauthorized(m.to_string());

        if let Some(header) = parts.headers.get(header::AUTHORIZATION) {
            let dev = header
                .to_str()
                .ok()
                .and_then(|h| h.strip_prefix("Bearer ").or(h.strip_prefix("bearer ")))
                .and_then(|token| token.trim().strip_prefix("dev:"))
                .filter(|_| state.config.auth_dev)
                .ok_or_else(|| bad("invalid token"))?;
            if !valid_user_id(dev) {
                return Err(bad("invalid dev user id"));
            }
            state.ensure_user(dev).await?;
            return Ok(AuthUser {
                user_id: dev.to_string(),
            });
        }

        if !parts.method.is_safe() {
            require_own_origin(state, &parts.headers)?;
        }
        match browser_session(state, &parts.headers).await? {
            Some((_, user_id)) => Ok(AuthUser { user_id }),
            None => Err(bad("not signed in")),
        }
    }
}
