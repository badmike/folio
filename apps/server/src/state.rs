//! Shared application state.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use object_store::ObjectStore;
use sqlx::SqlitePool;

use crate::ai::AiProvider;
use crate::auth::JwksCache;
use crate::config::Config;
use crate::error::AppResult;
use crate::ratelimit::RateLimiter;
use crate::util::now_ms;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub config: Arc<Config>,
    pub store: Arc<dyn ObjectStore>,
    pub ai: Arc<dyn AiProvider>,
    pub jwks: Arc<JwksCache>,
    pub push_limiter: Arc<RateLimiter>,
    seen_users: Arc<Mutex<HashSet<String>>>,
}

impl AppState {
    pub fn new(
        db: SqlitePool,
        config: Config,
        store: Arc<dyn ObjectStore>,
        ai: Arc<dyn AiProvider>,
        jwks: JwksCache,
    ) -> Self {
        let push_limiter = Arc::new(RateLimiter::new(config.push_rate_per_min));
        Self {
            db,
            config: Arc::new(config),
            store,
            ai,
            jwks: Arc::new(jwks),
            push_limiter,
            seen_users: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Upserts the users row the first time this process sees a user.
    pub async fn ensure_user(&self, user_id: &str) -> AppResult<()> {
        if self.seen_users.lock().unwrap().contains(user_id) {
            return Ok(());
        }
        sqlx::query("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)")
            .bind(user_id)
            .bind(now_ms())
            .execute(&self.db)
            .await?;
        self.seen_users.lock().unwrap().insert(user_id.to_string());
        Ok(())
    }
}
