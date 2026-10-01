//! folio-server: thin replication, asset and AI endpoint for the folio notebook.

pub mod ai;
pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod ratelimit;
pub mod routes;
pub mod state;
pub mod storage;
pub mod util;
pub mod web;

use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::http::{header, HeaderName, Method, Request, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tower::ServiceBuilder;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::compression::CompressionLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

pub use state::AppState;

/// Release version (`FOLIO_VERSION` at build time, e.g. `26.10.1-8e5921d`), else the crate version.
pub const VERSION: &str = match option_env!("FOLIO_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "version": VERSION }))
}

async fn fallback() -> error::AppError {
    error::AppError::NotFound("no such route".into())
}

/// API under `/api`, `/health` at the root, and the web app (if configured) everywhere else.
pub fn build_router(state: AppState) -> Router {
    let cfg = state.config.clone();
    // Base64 inflates by 4/3; leave room for JSON framing.
    let sync_limit = cfg.max_update_bytes.max(cfg.max_asset_bytes) / 3 * 4 + 64 * 1024;
    let x_request_id = HeaderName::from_static("x-request-id");

    let api = Router::new()
        .route("/health", get(health))
        .route(
            "/sync/push",
            post(routes::sync::push).layer(DefaultBodyLimit::max(
                cfg.max_update_bytes / 3 * 4 + 64 * 1024,
            )),
        )
        .route("/sync/pull", get(routes::sync::pull))
        .route(
            "/sync/compact",
            post(routes::sync::compact).layer(DefaultBodyLimit::max(sync_limit)),
        )
        .route("/sync/docs", get(routes::sync::list_docs))
        .route("/sync/changes", get(routes::sync::changes))
        .route("/devices", post(routes::devices::register))
        .route(
            "/assets",
            post(routes::assets::upload).layer(DefaultBodyLimit::max(cfg.max_asset_bytes)),
        )
        .route("/assets/{id}", get(routes::assets::download))
        .route(
            "/ai/recognize",
            post(routes::ai::recognize).layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        .route(
            "/ai/summarize",
            post(routes::ai::summarize).layer(DefaultBodyLimit::max(2 * 1024 * 1024)),
        )
        .route(
            "/ai/ask",
            post(routes::ai::ask).layer(DefaultBodyLimit::max(2 * 1024 * 1024)),
        )
        .fallback(fallback)
        .with_state(state.clone());

    let mut app = Router::new()
        .route("/health", get(health))
        .nest("/api", api);
    app = match &cfg.web_dir {
        Some(dir) => app.fallback_service(web::router(state, dir)),
        None => app.fallback(fallback),
    };

    if !cfg.cors_origins.is_empty() {
        let origin = if cfg.cors_origins.iter().any(|o| o == "*") {
            AllowOrigin::any()
        } else {
            AllowOrigin::list(cfg.cors_origins.iter().filter_map(|o| o.parse().ok()))
        };
        app = app.layer(
            CorsLayer::new()
                .allow_origin(origin)
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
                .max_age(Duration::from_secs(600)),
        );
    }

    app.layer(
        ServiceBuilder::new()
            .layer(SetRequestIdLayer::new(x_request_id.clone(), MakeRequestUuid))
            .layer(
                TraceLayer::new_for_http().make_span_with(|req: &Request<_>| {
                    let id = req
                        .headers()
                        .get("x-request-id")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("-");
                    tracing::info_span!("http", method = %req.method(), path = %req.uri().path(), request_id = %id)
                }),
            )
            .layer(PropagateRequestIdLayer::new(x_request_id))
            .layer(CatchPanicLayer::new())
            .layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(300)))
            .layer(CompressionLayer::new()),
    )
}
