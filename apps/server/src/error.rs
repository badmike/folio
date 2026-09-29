//! Structured application errors rendered as JSON `{error, message}`.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    PayloadTooLarge(String),
    #[error("{0}")]
    RateLimited(String),
    #[error("daily AI quota exhausted")]
    QuotaExceeded,
    #[error("AI not configured")]
    AiNotConfigured,
    #[error("upstream error: {0}")]
    Upstream(String),
    #[error("internal error")]
    Internal(#[source] anyhow::Error),
}

impl AppError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::PayloadTooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            Self::RateLimited(_) | Self::QuotaExceeded => StatusCode::TOO_MANY_REQUESTS,
            Self::AiNotConfigured => StatusCode::SERVICE_UNAVAILABLE,
            Self::Upstream(_) => StatusCode::BAD_GATEWAY,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Unauthorized(_) => "unauthorized",
            Self::BadRequest(_) => "bad_request",
            Self::NotFound(_) => "not_found",
            Self::Conflict(_) => "conflict",
            Self::PayloadTooLarge(_) => "payload_too_large",
            Self::RateLimited(_) => "rate_limited",
            Self::QuotaExceeded => "quota_exceeded",
            Self::AiNotConfigured => "ai_not_configured",
            Self::Upstream(_) => "upstream_error",
            Self::Internal(_) => "internal",
        }
    }

    pub fn internal(e: impl Into<anyhow::Error>) -> Self {
        Self::Internal(e.into())
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(counter = "db_error", error = %e, "database failure");
        Self::Internal(e.into())
    }
}

impl From<object_store::Error> for AppError {
    fn from(e: object_store::Error) -> Self {
        tracing::error!(counter = "storage_error", error = %e, "object store failure");
        Self::Internal(e.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        // Never leak internals to clients; log them instead.
        let message = match &self {
            Self::Internal(e) => {
                tracing::error!(counter = "internal_error", error = ?e, "internal error");
                "internal server error".to_string()
            }
            other => other.to_string(),
        };
        if matches!(self, Self::Unauthorized(_)) {
            tracing::warn!(counter = "auth_failure", message = %message, "auth rejected");
        }
        (status, Json(json!({ "error": self.code(), "message": message }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
