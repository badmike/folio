//! Replication endpoints. Update and snapshot payloads are opaque CRDT blobs.

use std::time::Duration;

use axum::extract::{Query, State};
use axum::Json;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use object_store::{path::Path as ObjPath, ObjectStoreExt, PutPayload};
use serde::{Deserialize, Serialize};
use sqlx::Row;

use super::ApiJson;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::util::{now_ms, seg, validate_id};

const DEFAULT_PULL_LIMIT: i64 = 500;
const MAX_PULL_LIMIT: i64 = 2000;
/// Soft cap on update bytes returned per pull page (at least one update is always returned).
const MAX_PULL_BYTES: usize = 16 * 1024 * 1024;

fn decode_b64(what: &str, s: &str) -> AppResult<Vec<u8>> {
    B64.decode(s.trim())
        .map_err(|_| AppError::BadRequest(format!("{what} is not valid base64")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushReq {
    pub doc_id: String,
    pub device_id: String,
    pub update: String,
}

#[derive(Serialize)]
pub struct PushRes {
    pub seq: i64,
}

/// POST /sync/push
pub async fn push(
    State(st): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<PushReq>,
) -> AppResult<Json<PushRes>> {
    let res = push_inner(&st, &user, req).await;
    if let Err(e) = &res {
        if !matches!(e, AppError::BadRequest(_)) {
            tracing::warn!(counter = "sync_failure", op = "push", user = %user.user_id, error = %e);
        }
    }
    res.map(Json)
}

async fn push_inner(st: &AppState, user: &AuthUser, req: PushReq) -> AppResult<PushRes> {
    validate_id("docId", &req.doc_id)?;
    validate_id("deviceId", &req.device_id)?;
    // Cheap size pre-check on the encoded form before allocating the decoded buffer.
    if req.update.len() > st.config.max_update_bytes / 3 * 4 + 8 {
        return Err(AppError::PayloadTooLarge(format!(
            "update exceeds {} bytes",
            st.config.max_update_bytes
        )));
    }
    let bytes = decode_b64("update", &req.update)?;
    if bytes.is_empty() {
        return Err(AppError::BadRequest("update must not be empty".into()));
    }
    if bytes.len() > st.config.max_update_bytes {
        return Err(AppError::PayloadTooLarge(format!(
            "update exceeds {} bytes",
            st.config.max_update_bytes
        )));
    }
    if !st.push_limiter.check(&user.user_id) {
        return Err(AppError::RateLimited(
            "too many sync pushes, slow down".into(),
        ));
    }

    let now = now_ms();
    let mut tx = st.db.begin().await?;
    let seq: i64 = sqlx::query(
        "INSERT INTO doc_updates (user_id, doc_id, device_id, bytes, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING seq",
    )
    .bind(&user.user_id)
    .bind(&req.doc_id)
    .bind(&req.device_id)
    .bind(&bytes)
    .bind(bytes.len() as i64)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?
    .get("seq");
    sqlx::query(
        "INSERT INTO docs (user_id, doc_id, latest_seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, doc_id) DO UPDATE SET latest_seq = excluded.latest_seq, updated_at = excluded.updated_at",
    )
    .bind(&user.user_id)
    .bind(&req.doc_id)
    .bind(seq)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE devices SET last_seen = ? WHERE user_id = ? AND id = ?")
        .bind(now)
        .bind(&user.user_id)
        .bind(&req.device_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let _ = st.sync_changes.send(user.user_id.clone());
    Ok(PushRes { seq })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullQuery {
    pub doc_id: String,
    #[serde(default)]
    pub since: i64,
    pub limit: Option<i64>,
}

#[derive(Serialize)]
pub struct UpdateItem {
    pub seq: i64,
    pub update: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotItem {
    pub upto_seq: i64,
    pub data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRes {
    pub updates: Vec<UpdateItem>,
    pub latest_seq: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<SnapshotItem>,
    /// True when more updates remain after the last returned one; pull again with `since` = last seq.
    pub has_more: bool,
}

/// GET /sync/pull
pub async fn pull(
    State(st): State<AppState>,
    user: AuthUser,
    Query(q): Query<PullQuery>,
) -> AppResult<Json<PullRes>> {
    validate_id("docId", &q.doc_id)?;
    if q.since < 0 {
        return Err(AppError::BadRequest("since must be >= 0".into()));
    }
    let limit = q
        .limit
        .unwrap_or(DEFAULT_PULL_LIMIT)
        .clamp(1, MAX_PULL_LIMIT);

    let latest_seq: i64 =
        sqlx::query("SELECT latest_seq FROM docs WHERE user_id = ? AND doc_id = ?")
            .bind(&user.user_id)
            .bind(&q.doc_id)
            .fetch_optional(&st.db)
            .await?
            .map(|r| r.get("latest_seq"))
            .unwrap_or(0);

    // Newest snapshot the client has not yet seen.
    let mut from = q.since;
    let mut snapshot = None;
    if let Some(row) = sqlx::query(
        "SELECT upto_seq, object_key FROM doc_snapshots
         WHERE user_id = ? AND doc_id = ? AND upto_seq > ? ORDER BY upto_seq DESC LIMIT 1",
    )
    .bind(&user.user_id)
    .bind(&q.doc_id)
    .bind(q.since)
    .fetch_optional(&st.db)
    .await?
    {
        let upto: i64 = row.get("upto_seq");
        let key: String = row.get("object_key");
        let data = st
            .store
            .get(&ObjPath::from(key.as_str()))
            .await
            .map_err(|e| {
                tracing::error!(counter = "storage_error", op = "snapshot_get", error = %e);
                AppError::internal(e)
            })?
            .bytes()
            .await
            .map_err(AppError::internal)?;
        snapshot = Some(SnapshotItem {
            upto_seq: upto,
            data: B64.encode(&data),
        });
        from = upto;
    }

    let rows = sqlx::query(
        "SELECT seq, bytes FROM doc_updates WHERE user_id = ? AND doc_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    )
    .bind(&user.user_id)
    .bind(&q.doc_id)
    .bind(from)
    .bind(limit + 1)
    .fetch_all(&st.db)
    .await?;

    let mut updates = Vec::new();
    let mut total = 0usize;
    let mut has_more = false;
    for (i, r) in rows.iter().enumerate() {
        let bytes: Vec<u8> = r.get("bytes");
        if i as i64 >= limit || (i > 0 && total + bytes.len() > MAX_PULL_BYTES) {
            has_more = true;
            break;
        }
        total += bytes.len();
        updates.push(UpdateItem {
            seq: r.get("seq"),
            update: B64.encode(&bytes),
        });
    }
    Ok(Json(PullRes {
        updates,
        latest_seq,
        snapshot,
        has_more,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactReq {
    pub doc_id: String,
    pub upto_seq: i64,
    pub snapshot: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactRes {
    pub upto_seq: i64,
    pub deleted_updates: u64,
}

/// POST /sync/compact — store a client-merged snapshot and drop the updates it subsumes.
pub async fn compact(
    State(st): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CompactReq>,
) -> AppResult<Json<CompactRes>> {
    validate_id("docId", &req.doc_id)?;
    let data = decode_b64("snapshot", &req.snapshot)?;
    if data.is_empty() {
        return Err(AppError::BadRequest("snapshot must not be empty".into()));
    }
    if data.len() > st.config.max_asset_bytes {
        return Err(AppError::PayloadTooLarge(format!(
            "snapshot exceeds {} bytes",
            st.config.max_asset_bytes
        )));
    }
    let latest: Option<i64> =
        sqlx::query("SELECT latest_seq FROM docs WHERE user_id = ? AND doc_id = ?")
            .bind(&user.user_id)
            .bind(&req.doc_id)
            .fetch_optional(&st.db)
            .await?
            .map(|r| r.get("latest_seq"));
    let latest = latest.ok_or_else(|| AppError::NotFound("unknown document".into()))?;
    if req.upto_seq < 1 || req.upto_seq > latest {
        return Err(AppError::BadRequest(format!(
            "uptoSeq must be between 1 and {latest}"
        )));
    }
    let existing: Option<i64> = sqlx::query(
        "SELECT MAX(upto_seq) AS m FROM doc_snapshots WHERE user_id = ? AND doc_id = ?",
    )
    .bind(&user.user_id)
    .bind(&req.doc_id)
    .fetch_one(&st.db)
    .await?
    .get("m");
    if existing.is_some_and(|e| e >= req.upto_seq) {
        return Err(AppError::Conflict(
            "a newer or equal snapshot already exists".into(),
        ));
    }

    let key = format!(
        "snapshots/{}/{}/{:020}.bin",
        seg(&user.user_id),
        seg(&req.doc_id),
        req.upto_seq
    );
    st.store
        .put(&ObjPath::from(key.as_str()), PutPayload::from(data))
        .await
        .map_err(|e| {
            tracing::error!(counter = "storage_error", op = "snapshot_put", error = %e);
            AppError::internal(e)
        })?;

    let mut tx = st.db.begin().await?;
    sqlx::query(
        "INSERT INTO doc_snapshots (user_id, doc_id, upto_seq, object_key, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&user.user_id)
    .bind(&req.doc_id)
    .bind(req.upto_seq)
    .bind(&key)
    .bind(now_ms())
    .execute(&mut *tx)
    .await?;
    let deleted =
        sqlx::query("DELETE FROM doc_updates WHERE user_id = ? AND doc_id = ? AND seq <= ?")
            .bind(&user.user_id)
            .bind(&req.doc_id)
            .bind(req.upto_seq)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    let old: Vec<String> = sqlx::query(
        "SELECT object_key FROM doc_snapshots WHERE user_id = ? AND doc_id = ? AND upto_seq < ?",
    )
    .bind(&user.user_id)
    .bind(&req.doc_id)
    .bind(req.upto_seq)
    .fetch_all(&mut *tx)
    .await?
    .iter()
    .map(|r| r.get("object_key"))
    .collect();
    sqlx::query("DELETE FROM doc_snapshots WHERE user_id = ? AND doc_id = ? AND upto_seq < ?")
        .bind(&user.user_id)
        .bind(&req.doc_id)
        .bind(req.upto_seq)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    // Best-effort cleanup of superseded snapshot objects.
    for k in old {
        if let Err(e) = st.store.delete(&ObjPath::from(k.as_str())).await {
            tracing::warn!(counter = "storage_error", op = "snapshot_cleanup", error = %e);
        }
    }
    Ok(Json(CompactRes {
        upto_seq: req.upto_seq,
        deleted_updates: deleted,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocItem {
    pub doc_id: String,
    pub latest_seq: i64,
    pub updated_at: i64,
}

/// GET /sync/docs — documents known to the server for this user.
pub async fn list_docs(
    State(st): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<DocItem>>> {
    let rows = sqlx::query(
        "SELECT doc_id, latest_seq, updated_at FROM docs WHERE user_id = ? ORDER BY updated_at DESC, doc_id",
    )
    .bind(&user.user_id)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(
        rows.iter()
            .map(|r| DocItem {
                doc_id: r.get("doc_id"),
                latest_seq: r.get("latest_seq"),
                updated_at: r.get("updated_at"),
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct ChangesQuery {
    #[serde(default)]
    pub since: i64,
}

#[derive(Serialize)]
pub struct ChangesRes {
    pub cursor: i64,
    pub docs: Vec<DocItem>,
}

/// Authenticated long poll. Durable sequences also cover updates between requests.
pub async fn changes(
    State(st): State<AppState>,
    user: AuthUser,
    Query(q): Query<ChangesQuery>,
) -> AppResult<Json<ChangesRes>> {
    if q.since < 0 {
        return Err(AppError::BadRequest("since must be >= 0".into()));
    }
    // Subscribe before reading so a push during the query cannot be missed.
    let mut notifications = st.sync_changes.subscribe();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let rows = sqlx::query(
            "SELECT doc_id, latest_seq, updated_at FROM docs
             WHERE user_id = ? AND latest_seq > ? ORDER BY latest_seq",
        )
        .bind(&user.user_id)
        .bind(q.since)
        .fetch_all(&st.db)
        .await?;
        let docs: Vec<DocItem> = rows
            .iter()
            .map(|r| DocItem {
                doc_id: r.get("doc_id"),
                latest_seq: r.get("latest_seq"),
                updated_at: r.get("updated_at"),
            })
            .collect();
        if !docs.is_empty() || tokio::time::Instant::now() >= deadline {
            let cursor = docs.iter().map(|d| d.latest_seq).max().unwrap_or(q.since);
            return Ok(Json(ChangesRes { cursor, docs }));
        }
        loop {
            match tokio::time::timeout_at(deadline, notifications.recv()).await {
                Ok(Ok(owner)) if owner != user.user_id => continue,
                // Lagged notifications are recovered by the next database read.
                _ => break,
            }
        }
    }
}
