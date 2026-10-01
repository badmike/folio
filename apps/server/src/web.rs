//! Serves the built web app next to the API, so one container is a full install.

use std::path::Path;

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use tower_http::services::{ServeDir, ServeFile};

use crate::AppState;

/// Runtime config the web app reads at boot (see apps/web/src/services/runtime-config.ts).
async fn config(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "apiBase": "/api",
        "clerkPublishableKey": state.config.clerk_publishable_key.as_deref().unwrap_or(""),
    }))
}

/// Hashed build output is immutable; everything else (index.html, sw.js, manifest) revalidates.
async fn cache_control(req: Request, next: Next) -> Response {
    let immutable = req.uri().path().starts_with("/assets/");
    let mut res = next.run(req).await;
    let value = if immutable {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    res
}

/// `/config.json` plus the static files in `dir`, falling back to `index.html` for client routes.
pub fn router(state: AppState, dir: &Path) -> Router {
    let files = ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")));
    Router::new()
        .route("/config.json", get(config))
        .fallback_service(files)
        .layer(middleware::from_fn(cache_control))
        .with_state(state)
}
