use axum::extract::{Path, State};
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Response};
use axum::Json;
use cookie::time::Duration;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use webauthn_rs::prelude::{PublicKeyCredential, RegisterPublicKeyCredential};

use super::ApiJson;
use crate::accounts::{self, Accounts};
use crate::auth::{self, AuthUser, SESSION_COOKIE};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

fn accounts(st: &AppState) -> AppResult<&Accounts> {
    st.accounts
        .as_deref()
        .ok_or_else(|| AppError::NotFound("accounts are not set up on this server".into()))
}

async fn user_json(db: &SqlitePool, user_id: &str) -> AppResult<Value> {
    let (name,): (Option<String>,) = sqlx::query_as("SELECT name FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_one(db)
        .await?;
    Ok(json!({ "id": user_id, "name": name }))
}

/// Starts a session for `user_id` and answers `body` with its cookie.
async fn signed_in(st: &AppState, user_id: &str, mut body: Value) -> AppResult<Response> {
    let cfg = st.config.accounts.as_ref().expect("accounts are set up");
    let days = st.config.session_days;
    let token = auth::create_session(&st.db, user_id, days).await?;
    body["user"] = user_json(&st.db, user_id).await?;
    let mut res = Json(body).into_response();
    res.headers_mut().append(
        header::SET_COOKIE,
        auth::set_cookie(cfg, SESSION_COOKIE, &token, Duration::days(days)),
    );
    Ok(res)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterStart {
    /// Invite or reset token from the link. Without one, a signed-in person adds a passkey.
    token: Option<String>,
    /// Display name for a new account.
    name: Option<String>,
}

/// POST /auth/passkey/register/start -> `{ceremony, options}` for `navigator.credentials.create`.
pub async fn register_start(
    State(st): State<AppState>,
    headers: HeaderMap,
    ApiJson(b): ApiJson<RegisterStart>,
) -> AppResult<Json<Value>> {
    let accounts = accounts(&st)?;
    auth::require_own_origin(&st, &headers)?;
    let (ceremony, options) = match b.token {
        Some(token) => accounts.start_enrollment(&st.db, token, b.name).await?,
        None => {
            let (_, user_id) = auth::browser_session(&st, &headers)
                .await?
                .ok_or_else(|| AppError::Unauthorized("not signed in".into()))?;
            accounts.start_adding(&st.db, user_id).await?
        }
    };
    Ok(Json(json!({ "ceremony": ceremony, "options": options })))
}

#[derive(Deserialize)]
pub struct RegisterFinish {
    ceremony: String,
    credential: RegisterPublicKeyCredential,
}

/// POST /auth/passkey/register/finish -> `{user, recoveryCodes?}`. A new or reset account is
/// signed in and gets its recovery codes.
pub async fn register_finish(
    State(st): State<AppState>,
    headers: HeaderMap,
    ApiJson(b): ApiJson<RegisterFinish>,
) -> AppResult<Response> {
    let accounts = accounts(&st)?;
    auth::require_own_origin(&st, &headers)?;
    let session = auth::browser_session(&st, &headers).await?;
    let signed_in_as = session.as_ref().map(|(_, user_id)| user_id.as_str());
    let done = accounts
        .finish_registration(&st.db, &b.ceremony, &b.credential, signed_in_as)
        .await?;
    match done.recovery_codes {
        Some(codes) => signed_in(&st, &done.user_id, json!({ "recoveryCodes": codes })).await,
        None => {
            let user = user_json(&st.db, &done.user_id).await?;
            Ok(Json(json!({ "user": user })).into_response())
        }
    }
}

/// POST /auth/passkey/login/start -> `{ceremony, options}` for `navigator.credentials.get`.
pub async fn login_start(State(st): State<AppState>) -> AppResult<Json<Value>> {
    let (ceremony, options) = accounts(&st)?.start_login()?;
    Ok(Json(json!({ "ceremony": ceremony, "options": options })))
}

#[derive(Deserialize)]
pub struct LoginFinish {
    ceremony: String,
    credential: PublicKeyCredential,
}

/// POST /auth/passkey/login/finish -> `{user}` and the session cookie.
pub async fn login_finish(
    State(st): State<AppState>,
    headers: HeaderMap,
    ApiJson(b): ApiJson<LoginFinish>,
) -> AppResult<Response> {
    let accounts = accounts(&st)?;
    auth::require_own_origin(&st, &headers)?;
    let user_id = accounts
        .finish_login(&st.db, &b.ceremony, &b.credential)
        .await?;
    signed_in(&st, &user_id, json!({})).await
}

#[derive(Deserialize)]
pub struct Recover {
    code: String,
}

/// POST /auth/recover `{code}` -> `{user}` and the session cookie. Uses the code up.
pub async fn recover(
    State(st): State<AppState>,
    headers: HeaderMap,
    ApiJson(b): ApiJson<Recover>,
) -> AppResult<Response> {
    accounts(&st)?;
    auth::require_own_origin(&st, &headers)?;
    let user_id = accounts::recover(&st.db, &b.code).await?;
    signed_in(&st, &user_id, json!({})).await
}

/// GET /auth/account -> `{passkeys, recoveryCodesLeft}`.
pub async fn account(State(st): State<AppState>, user: AuthUser) -> AppResult<Json<Value>> {
    let passkeys = accounts::passkeys(&st.db, &user.user_id).await?;
    let left = accounts::recovery_codes_left(&st.db, &user.user_id).await?;
    Ok(Json(
        json!({ "passkeys": passkeys, "recoveryCodesLeft": left }),
    ))
}

/// DELETE /auth/passkeys/{id}. The last passkey of an account can't be removed.
pub async fn delete_passkey(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    accounts::delete_passkey(&st.db, &user.user_id, &id).await?;
    Ok(Json(json!({})))
}

/// POST /auth/recovery-codes -> `{recoveryCodes}`, replacing the old ones.
pub async fn recovery_codes(State(st): State<AppState>, user: AuthUser) -> AppResult<Json<Value>> {
    let codes = accounts::new_recovery_codes(&st.db, &user.user_id).await?;
    Ok(Json(json!({ "recoveryCodes": codes })))
}

/// GET /auth/session — whether this server offers sign-in, and who is signed in.
/// Also renews the cookie, so it lives as long as the session it names.
pub async fn session(State(st): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let Some(cfg) = &st.config.accounts else {
        return Ok(Json(json!({ "available": false, "user": null })).into_response());
    };
    let Some((token, user_id)) = auth::browser_session(&st, &headers).await? else {
        return Ok(Json(json!({ "available": true, "user": null })).into_response());
    };
    let user = user_json(&st.db, &user_id).await?;
    let mut res = Json(json!({ "available": true, "user": user })).into_response();
    res.headers_mut().append(
        header::SET_COOKIE,
        auth::set_cookie(
            cfg,
            SESSION_COOKIE,
            &token,
            Duration::days(st.config.session_days),
        ),
    );
    Ok(res)
}

/// POST /auth/logout — ends this browser's session.
pub async fn logout(
    State(st): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
) -> AppResult<Response> {
    let mut res = Json(json!({})).into_response();
    if let Some(cfg) = &st.config.accounts {
        if let Some(token) = auth::read_cookie(cfg, &headers, SESSION_COOKIE) {
            auth::delete_session(&st.db, &token).await?;
        }
        res.headers_mut().append(
            header::SET_COOKIE,
            auth::set_cookie(cfg, SESSION_COOKIE, "", Duration::ZERO),
        );
    }
    Ok(res)
}
