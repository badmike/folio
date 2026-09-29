use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::ApiJson;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::util::{now_ms, validate_id};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDevice {
    pub device_id: String,
    pub name: String,
}

/// POST /devices — register a device or refresh its heartbeat.
pub async fn register(
    State(st): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<RegisterDevice>,
) -> AppResult<Json<Value>> {
    validate_id("deviceId", &req.device_id)?;
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 128 {
        return Err(AppError::BadRequest("name must be 1-128 characters".into()));
    }
    let now = now_ms();
    sqlx::query(
        "INSERT INTO devices (id, user_id, name, last_seen) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen",
    )
    .bind(&req.device_id)
    .bind(&user.user_id)
    .bind(name)
    .bind(now)
    .execute(&st.db)
    .await?;
    Ok(Json(json!({ "deviceId": req.device_id, "lastSeen": now })))
}
