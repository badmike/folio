use axum::extract::State;
use axum::Json;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use sqlx::Row;

use super::ApiJson;
use crate::ai::{self, AiRequest, AiResponse};
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::util::{now_ms, utc_day};

const MAX_IMAGE_B64: usize = 14 * 1024 * 1024;
const MAX_CONTEXT_CHARS: usize = 400_000;
const MAX_QUESTION_CHARS: usize = 8_000;

/// Runs one AI call with quota accounting and ai_jobs bookkeeping.
async fn run(st: &AppState, user: &AuthUser, kind: &str, req: AiRequest) -> AppResult<AiResponse> {
    // Don't burn quota when the feature is off.
    if !st.ai.is_configured() {
        return Err(AppError::AiNotConfigured);
    }
    let day = utc_day(now_ms());
    if st.config.ai_daily_quota <= 0 {
        return Err(AppError::QuotaExceeded);
    }
    let claimed = sqlx::query(
        "INSERT INTO quotas (user_id, day, ai_requests) VALUES (?, ?, 1)
         ON CONFLICT(user_id, day) DO UPDATE SET ai_requests = ai_requests + 1 WHERE ai_requests < ?
         RETURNING ai_requests",
    )
    .bind(&user.user_id)
    .bind(&day)
    .bind(st.config.ai_daily_quota)
    .fetch_optional(&st.db)
    .await?;
    if claimed.is_none() {
        return Err(AppError::QuotaExceeded);
    }

    let job_id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO ai_jobs (id, user_id, kind, status, created_at) VALUES (?, ?, ?, 'running', ?)")
        .bind(&job_id)
        .bind(&user.user_id)
        .bind(kind)
        .bind(now_ms())
        .execute(&st.db)
        .await?;

    match st.ai.complete(req).await {
        Ok(res) => {
            sqlx::query("UPDATE ai_jobs SET status = 'ok', tokens_in = ?, tokens_out = ? WHERE id = ?")
                .bind(res.tokens_in)
                .bind(res.tokens_out)
                .bind(&job_id)
                .execute(&st.db)
                .await?;
            Ok(res)
        }
        Err(e) => {
            tracing::warn!(counter = "ai_failure", kind, user = %user.user_id, error = %e);
            sqlx::query("UPDATE ai_jobs SET status = 'error' WHERE id = ?").bind(&job_id).execute(&st.db).await?;
            // Failed calls don't count against the user's quota.
            sqlx::query("UPDATE quotas SET ai_requests = MAX(ai_requests - 1, 0) WHERE user_id = ? AND day = ?")
                .bind(&user.user_id)
                .bind(&day)
                .execute(&st.db)
                .await?;
            Err(e)
        }
    }
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
    let raw = B64.decode(b64).map_err(|_| AppError::BadRequest("image is not valid base64".into()))?;
    if !raw.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err(AppError::BadRequest("image must be a PNG".into()));
    }
    if req.languages.len() > 8 || req.languages.iter().any(|l| l.len() > 16) {
        return Err(AppError::BadRequest("invalid languages".into()));
    }
    let hint = req.hint.as_deref().map(|h| h.chars().take(2000).collect::<String>());
    let ai_req = AiRequest {
        system: ai::RECOGNIZE_SYSTEM.to_string(),
        user_text: ai::recognize_user_text(&req.languages, hint.as_deref()),
        image_png_b64: Some(b64.to_string()),
        max_tokens: 2048,
    };
    let res = run(&st, &user, "recognize", ai_req).await?;
    let (text, confidence) = ai::parse_recognition(&res.text);
    Ok(Json(RecognizeRes { text, confidence }))
}

#[derive(Deserialize)]
pub struct SummarizeReq {
    pub context: String,
    pub kind: String,
}

#[derive(Serialize)]
pub struct MarkdownRes {
    pub markdown: String,
}

/// POST /ai/summarize
pub async fn summarize(
    State(st): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<SummarizeReq>,
) -> AppResult<Json<MarkdownRes>> {
    let instruction = ai::summarize_instruction(&req.kind).ok_or_else(|| {
        AppError::BadRequest("kind must be one of page, lecture, outline, flashcards, questions".into())
    })?;
    if req.context.trim().is_empty() || req.context.chars().count() > MAX_CONTEXT_CHARS {
        return Err(AppError::BadRequest("context missing or too large".into()));
    }
    let ai_req = AiRequest {
        system: ai::SUMMARIZE_SYSTEM.to_string(),
        user_text: format!("{instruction}\n\n<notes>\n{}\n</notes>", req.context),
        image_png_b64: None,
        max_tokens: 4096,
    };
    let res = run(&st, &user, &format!("summarize:{}", req.kind), ai_req).await?;
    Ok(Json(MarkdownRes { markdown: res.text.trim().to_string() }))
}

#[derive(Deserialize)]
pub struct AskReq {
    pub question: String,
    #[serde(default)]
    pub context: String,
}

/// POST /ai/ask
pub async fn ask(
    State(st): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<AskReq>,
) -> AppResult<Json<MarkdownRes>> {
    if req.question.trim().is_empty() || req.question.chars().count() > MAX_QUESTION_CHARS {
        return Err(AppError::BadRequest("question missing or too long".into()));
    }
    if req.context.chars().count() > MAX_CONTEXT_CHARS {
        return Err(AppError::BadRequest("context too large".into()));
    }
    let ai_req = AiRequest {
        system: ai::ASK_SYSTEM.to_string(),
        user_text: format!("<notes>\n{}\n</notes>\n\nQuestion: {}", req.context, req.question),
        image_png_b64: None,
        max_tokens: 4096,
    };
    let res = run(&st, &user, "ask", ai_req).await?;
    Ok(Json(MarkdownRes { markdown: res.text.trim().to_string() }))
}

/// Number of AI requests a user has consumed today (used by tests / diagnostics).
pub async fn used_today(st: &AppState, user_id: &str) -> AppResult<i64> {
    Ok(sqlx::query("SELECT ai_requests FROM quotas WHERE user_id = ? AND day = ?")
        .bind(user_id)
        .bind(utc_day(now_ms()))
        .fetch_optional(&st.db)
        .await?
        .map(|r| r.get("ai_requests"))
        .unwrap_or(0))
}
