pub mod ai;
pub mod assets;
pub mod devices;
pub mod sync;

use axum::extract::rejection::{BytesRejection, JsonRejection};
use axum::extract::{FromRequest, Request};
use axum::http::StatusCode;
use axum::Json;
use serde::de::DeserializeOwned;

use crate::error::AppError;

/// JSON extractor whose rejections are rendered as structured `AppError`s.
pub struct ApiJson<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for ApiJson<T> {
    type Rejection = AppError;
    async fn from_request(req: Request, state: &S) -> Result<Self, AppError> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(v)) => Ok(Self(v)),
            Err(e) => Err(json_rejection(e)),
        }
    }
}

fn json_rejection(e: JsonRejection) -> AppError {
    if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
        AppError::PayloadTooLarge("request body too large".into())
    } else {
        AppError::BadRequest(format!("invalid JSON body: {}", e.body_text()))
    }
}

pub fn bytes_rejection(e: BytesRejection) -> AppError {
    if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
        AppError::PayloadTooLarge("request body too large".into())
    } else {
        AppError::BadRequest("could not read request body".into())
    }
}
