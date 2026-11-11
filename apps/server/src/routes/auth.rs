use axum::extract::{Query, State};
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use cookie::time::Duration;
use serde::Deserialize;
use serde_json::json;

use crate::auth::{self, AuthUser, SESSION_COOKIE};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Holds the state, nonce and PKCE verifier of a sign-in attempt between login and callback.
const PENDING_COOKIE: &str = "folio_signin";

fn not_configured() -> AppError {
    AppError::NotFound("accounts are not set up on this server".into())
}

/// GET /auth/login — sends the browser to the sign-in provider.
pub async fn login(State(st): State<AppState>) -> AppResult<Response> {
    let oidc = st.oidc.as_ref().ok_or_else(not_configured)?;
    let cfg = oidc.config();
    let (url, pending) = oidc.begin().await?;
    let mut res = Redirect::to(&url).into_response();
    res.headers_mut().append(
        header::SET_COOKIE,
        auth::set_cookie(cfg, PENDING_COOKIE, &pending, Duration::minutes(10)),
    );
    Ok(res)
}

#[derive(Deserialize)]
pub struct Callback {
    code: Option<String>,
    state: Option<String>,
}

/// GET /auth/callback — the provider's redirect. Starts the session and returns to the app,
/// with `?signin=failed` when the sign-in did not complete.
pub async fn callback(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<Callback>,
) -> AppResult<Response> {
    let oidc = st.oidc.as_ref().ok_or_else(not_configured)?;
    let cfg = oidc.config();
    let days = st.config.session_days;

    let session = async {
        let bad = |m: &str| AppError::Unauthorized(m.to_string());
        let pending = auth::read_cookie(cfg, &headers, PENDING_COOKIE)
            .ok_or_else(|| bad("no sign-in in progress"))?;
        // The provider sends `error` instead of `code` when the person cancels.
        let (Some(code), Some(state)) = (q.code, q.state) else {
            return Err(bad("the provider returned no code"));
        };
        let profile = oidc.finish(code, &state, &pending).await?;
        let user_id = auth::user_for_identity(&st.db, &profile).await?;
        auth::create_session(&st.db, &user_id, days).await
    }
    .await;

    let app = format!("{}/", cfg.public_origin);
    let mut res = match session {
        Ok(token) => {
            let mut res = Redirect::to(&app).into_response();
            res.headers_mut().append(
                header::SET_COOKIE,
                auth::set_cookie(cfg, SESSION_COOKIE, &token, Duration::days(days)),
            );
            res
        }
        Err(e) => {
            tracing::warn!(counter = "auth_failure", error = %e, "sign-in failed");
            Redirect::to(&format!("{app}?signin=failed")).into_response()
        }
    };
    res.headers_mut().append(
        header::SET_COOKIE,
        auth::set_cookie(cfg, PENDING_COOKIE, "", Duration::ZERO),
    );
    Ok(res)
}

/// GET /auth/session — whether this server offers sign-in, and who is signed in.
/// Also renews the cookie, so it lives as long as the session it names.
pub async fn session(State(st): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let Some(cfg) = &st.config.oidc else {
        return Ok(Json(json!({ "available": false, "user": null })).into_response());
    };
    let Some((token, user_id)) = auth::browser_session(&st, &headers).await? else {
        return Ok(Json(json!({ "available": true, "user": null })).into_response());
    };
    let (email, name, picture): (Option<String>, Option<String>, Option<String>) =
        sqlx::query_as("SELECT email, name, picture FROM users WHERE id = ?")
            .bind(&user_id)
            .fetch_one(&st.db)
            .await?;
    let user = json!({ "id": user_id, "email": email, "name": name, "picture": picture });
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
    if let Some(cfg) = &st.config.oidc {
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
