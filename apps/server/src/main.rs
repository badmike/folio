use std::sync::Arc;

use folio_server::ai::{AiProvider, DisabledProvider, OpenRouterProvider};
use folio_server::auth::JwksCache;
use folio_server::config::Config;
use folio_server::{build_router, db, storage, AppState};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Minimal container healthcheck: `folio-server --healthcheck` probes /health on the bind port.
    if std::env::args().any(|a| a == "--healthcheck") {
        let port = std::env::var("FOLIO_BIND")
            .ok()
            .and_then(|b| b.rsplit(':').next().map(str::to_string))
            .unwrap_or_else(|| "8989".into());
        let ok = reqwest::get(format!("http://127.0.0.1:{port}/health"))
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        std::process::exit(if ok { 0 } else { 1 });
    }
    let filter = EnvFilter::try_from_env("FOLIO_LOG")
        .or_else(|_| EnvFilter::try_from_default_env())
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info,sqlx=warn"));
    if std::env::var("FOLIO_LOG_FORMAT").is_ok_and(|v| v == "pretty") {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    } else {
        tracing_subscriber::fmt()
            .json()
            .with_env_filter(filter)
            .init();
    }

    let config = Config::from_env()?;
    if config.auth_dev {
        tracing::warn!("FOLIO_AUTH_DEV is enabled: `Bearer dev:<user-id>` tokens are accepted. NEVER use in production.");
    }
    if config.clerk_jwks_url.is_none() && !config.auth_dev {
        tracing::warn!("no CLERK_JWKS_URL / CLERK_ISSUER configured and dev auth is off: every request will be rejected");
    }
    if config.clerk_issuer.is_none() && config.clerk_jwks_url.is_some() {
        tracing::warn!("CLERK_ISSUER not set: token issuer is not validated");
    }

    let pool = db::connect(&config.database_url).await?;
    let store = storage::build(&config.storage)?;
    let ai: Arc<dyn AiProvider> = match &config.openrouter_api_key {
        Some(key) => Arc::new(OpenRouterProvider::new(
            key.clone(),
            config.openrouter_base_url.clone(),
            config.ai_model.clone(),
            config.ai_vision_model.clone(),
        )),
        None => {
            tracing::warn!("OPENROUTER_API_KEY not set: /ai/* endpoints will answer 503");
            Arc::new(DisabledProvider)
        }
    };
    let jwks = JwksCache::new(config.clerk_jwks_url.clone());
    let bind = config.bind;
    let state = AppState::new(pool, config, store, ai, jwks);

    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(addr = %bind, version = env!("CARGO_PKG_VERSION"), "folio-server listening");
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("shutdown complete");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutdown signal received, draining");
}
