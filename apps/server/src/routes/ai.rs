use axum::extract::State;
use axum::Json;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};

use super::ApiJson;
use crate::agent::store;
use crate::ai::{self, AiRequest, AiResponse, Usage};
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const MAX_IMAGE_B64: usize = 14 * 1024 * 1024;

/// Runs one recognition call against the user's daily credit. Failed calls cost nothing.
async fn run(st: &AppState, user: &AuthUser, req: AiRequest) -> AppResult<AiResponse> {
    if !st.ai.is_configured() {
        return Err(AppError::AiNotConfigured);
    }
    if store::credit(&st.db, &st.config, &user.user_id)
        .await?
        .exhausted()
    {
        return Err(AppError::CreditExhausted);
    }
    let res = st.ai.complete(req).await.inspect_err(|e| {
        tracing::warn!(counter = "ai_failure", kind = "recognize", user = %user.user_id, error = %e);
    })?;
    let usage = Usage {
        prompt_tokens: res.tokens_in,
        completion_tokens: res.tokens_out,
        cached_tokens: 0,
    };
    let cost = st.config.default_preset().cost(&usage);
    store::record_usage(&st.db, &user.user_id, cost, res.tokens_in + res.tokens_out).await?;
    Ok(res)
}

#[derive(Deserialize)]
pub struct RecognizeReq {
    pub image: String,
    #[serde(default)]
    pub languages: Vec<String>,
    pub hint: Option<String>,
}

#[derive(Serialize)]
pub struct RecognizeRes {
    pub text: String,
    pub confidence: f64,
}

/// POST /ai/recognize
pub async fn recognize(
    State(st): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<RecognizeReq>,
) -> AppResult<Json<RecognizeRes>> {
    let b64 = req.image.trim();
    let b64 = b64.strip_prefix("data:image/png;base64,").unwrap_or(b64);
    if b64.is_empty() || b64.len() > MAX_IMAGE_B64 {
        return Err(AppError::BadRequest("image missing or too large".into()));
    }
    let raw = B64
        .decode(b64)
        .map_err(|_| AppError::BadRequest("image is not valid base64".into()))?;
    if !raw.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err(AppError::BadRequest("image must be a PNG".into()));
    }
    if req.languages.len() > 8 || req.languages.iter().any(|l| l.len() > 16) {
        return Err(AppError::BadRequest("invalid languages".into()));
    }
    let hint = req
        .hint
        .as_deref()
        .map(|h| h.chars().take(2000).collect::<String>());
    let ai_req = AiRequest {
        model: st.config.default_preset().model.clone(),
        system: ai::RECOGNIZE_SYSTEM.to_string(),
        user_text: ai::recognize_user_text(&req.languages, hint.as_deref()),
        image_png_b64: Some(b64.to_string()),
        max_tokens: 2048,
    };
    let res = run(&st, &user, ai_req).await?;
    let (text, confidence) = ai::parse_recognition(&res.text);
    Ok(Json(RecognizeRes { text, confidence }))
}
