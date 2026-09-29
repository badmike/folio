use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::Json;
use object_store::{path::Path as ObjPath, ObjectStoreExt, PutPayload};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use super::bytes_rejection;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::util::{now_ms, seg, validate_id};

#[derive(Deserialize)]
pub struct UploadQuery {
    pub id: Option<String>,
}

/// Extracts a bare `type/subtype` from a Content-Type header, defaulting to octet-stream.
fn clean_mime(headers: &HeaderMap) -> String {
    let raw = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    let base = raw.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let ok = base.len() <= 100
        && base.split_once('/').is_some_and(|(a, b)| {
            let tok = |s: &str| {
                !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&c))
            };
            tok(a) && tok(b)
        });
    if ok { base } else { "application/octet-stream".into() }
}

/// POST /assets
pub async fn upload(
    State(st): State<AppState>,
    user: AuthUser,
    Query(q): Query<UploadQuery>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> AppResult<Json<Value>> {
    let id = match q.id {
        Some(id) => {
            validate_id("asset id", &id)?;
            id
        }
        None => uuid::Uuid::new_v4().to_string(),
    };
    let body = body.map_err(bytes_rejection)?;
    if body.is_empty() {
        return Err(AppError::BadRequest("empty asset body".into()));
    }
    if body.len() > st.config.max_asset_bytes {
        return Err(AppError::PayloadTooLarge(format!("asset exceeds {} bytes", st.config.max_asset_bytes)));
    }
    let mime = clean_mime(&headers);
    let key = format!("assets/{}/{}", seg(&user.user_id), seg(&id));
    let size = body.len() as i64;
    st.store.put(&ObjPath::from(key.as_str()), PutPayload::from(body)).await.map_err(|e| {
        tracing::error!(counter = "storage_error", op = "asset_put", error = %e);
        AppError::internal(e)
    })?;
    sqlx::query(
        "INSERT INTO assets (id, user_id, mime, size, object_key, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET mime = excluded.mime, size = excluded.size, object_key = excluded.object_key",
    )
    .bind(&id)
    .bind(&user.user_id)
    .bind(&mime)
    .bind(size)
    .bind(&key)
    .bind(now_ms())
    .execute(&st.db)
    .await?;
    Ok(Json(json!({ "id": id })))
}

/// GET /assets/{id} — only the owner can read (lookup is scoped by user id).
pub async fn download(State(st): State<AppState>, user: AuthUser, Path(id): Path<String>) -> AppResult<Response> {
    validate_id("asset id", &id)?;
    let row = sqlx::query("SELECT mime, object_key FROM assets WHERE user_id = ? AND id = ?")
        .bind(&user.user_id)
        .bind(&id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::NotFound("asset not found".into()))?;
    let mime: String = row.get("mime");
    let key: String = row.get("object_key");
    let bytes = st
        .store
        .get(&ObjPath::from(key.as_str()))
        .await
        .map_err(|e| match e {
            object_store::Error::NotFound { .. } => AppError::NotFound("asset not found".into()),
            other => {
                tracing::error!(counter = "storage_error", op = "asset_get", error = %other);
                AppError::internal(other)
            }
        })?
        .bytes()
        .await
        .map_err(AppError::internal)?;
    let mut res = bytes.into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    // Uploaded content is untrusted: never let a browser sniff or execute it in our origin.
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert("content-security-policy", HeaderValue::from_static("sandbox; default-src 'none'"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=3600"));
    Ok(res)
}
