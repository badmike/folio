//! Authentication: Clerk session JWT verification (RS256 via JWKS) plus an
//! opt-in development token scheme (`Bearer dev:<user-id>`).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::extract::FromRequestParts;
use axum::http::{header, request::Parts};
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use tokio::sync::{Mutex, RwLock};

use crate::error::AppError;
use crate::state::AppState;

/// The authenticated caller. All data access is scoped by `user_id`.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: String,
}

#[derive(Debug, Deserialize)]
struct Claims {
    sub: String,
    #[serde(default)]
    azp: Option<String>,
}

/// Minimum interval between JWKS fetches (protects the IdP from kid-spam).
const DEFAULT_MIN_REFETCH: Duration = Duration::from_secs(10);
/// Keys are refreshed at least this often even when all kids are known.
const MAX_AGE: Duration = Duration::from_secs(3600);

pub struct JwksCache {
    url: Option<String>,
    http: reqwest::Client,
    keys: RwLock<HashMap<String, DecodingKey>>,
    last_fetch: Mutex<Option<Instant>>,
    min_refetch: Duration,
}

impl JwksCache {
    pub fn new(url: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client");
        Self {
            url,
            http,
            keys: RwLock::new(HashMap::new()),
            last_fetch: Mutex::new(None),
            min_refetch: DEFAULT_MIN_REFETCH,
        }
    }

    pub fn with_min_refetch(mut self, d: Duration) -> Self {
        self.min_refetch = d;
        self
    }

    /// Builds a cache pre-populated from a JWKS document (used by tests / offline setups).
    pub fn from_static(jwks_json: &str) -> anyhow::Result<Self> {
        let c = Self::new(None);
        let set: JwkSet = serde_json::from_str(jwks_json)?;
        let keys = Self::parse(set);
        *c.keys.try_write().expect("fresh lock") = keys;
        Ok(c)
    }

    fn parse(set: JwkSet) -> HashMap<String, DecodingKey> {
        set.keys
            .iter()
            .filter_map(|jwk| {
                let kid = jwk.common.key_id.clone()?;
                DecodingKey::from_jwk(jwk).ok().map(|k| (kid, k))
            })
            .collect()
    }

    async fn refresh(&self) -> Result<(), AppError> {
        let Some(url) = &self.url else { return Ok(()) };
        let mut last = self.last_fetch.lock().await;
        if let Some(t) = *last {
            if t.elapsed() < self.min_refetch {
                return Ok(());
            }
        }
        *last = Some(Instant::now());
        let res = self
            .http
            .get(url)
            .send()
            .await
            .and_then(|r| r.error_for_status());
        let set: JwkSet = match res {
            Ok(r) => r.json().await.map_err(|e| {
                tracing::error!(counter = "auth_jwks_error", error = %e, "invalid JWKS document");
                AppError::Unauthorized("authentication unavailable".into())
            })?,
            Err(e) => {
                tracing::error!(counter = "auth_jwks_error", error = %e, "JWKS fetch failed");
                return Err(AppError::Unauthorized("authentication unavailable".into()));
            }
        };
        *self.keys.write().await = Self::parse(set);
        Ok(())
    }

    /// Returns the key for `kid`, refreshing the JWKS if it is unknown or stale.
    async fn key(&self, kid: &str) -> Result<DecodingKey, AppError> {
        if let Some(k) = self.keys.read().await.get(kid) {
            let stale = matches!(*self.last_fetch.lock().await, Some(t) if t.elapsed() > MAX_AGE);
            if !stale {
                return Ok(k.clone());
            }
        }
        self.refresh().await?;
        self.keys
            .read()
            .await
            .get(kid)
            .cloned()
            .ok_or_else(|| AppError::Unauthorized("unknown signing key".into()))
    }

    pub async fn verify(
        &self,
        token: &str,
        cfg: &crate::config::Config,
    ) -> Result<String, AppError> {
        let bad = |m: &str| AppError::Unauthorized(m.to_string());
        let header = decode_header(token).map_err(|_| bad("malformed token"))?;
        if header.alg != Algorithm::RS256 {
            return Err(bad("unsupported token algorithm"));
        }
        let kid = header.kid.ok_or_else(|| bad("token has no kid"))?;
        let key = self.key(&kid).await?;

        let mut v = Validation::new(Algorithm::RS256);
        v.validate_exp = true;
        v.validate_nbf = true;
        v.validate_aud = false; // Clerk session tokens carry no `aud`.
        v.leeway = 30;
        v.set_required_spec_claims(&["exp", "sub"]);
        if let Some(iss) = &cfg.clerk_issuer {
            v.set_issuer(&[iss.trim_end_matches('/')]);
        }
        let data = decode::<Claims>(token, &key, &v).map_err(|e| {
            use jsonwebtoken::errors::ErrorKind::*;
            match e.kind() {
                ExpiredSignature => bad("token expired"),
                ImmatureSignature => bad("token not yet valid"),
                InvalidIssuer => bad("invalid token issuer"),
                _ => bad("invalid token"),
            }
        })?;
        if !cfg.clerk_authorized_parties.is_empty() {
            // azp is optional in the token, but if present it must be allowed.
            if let Some(azp) = &data.claims.azp {
                if !cfg.clerk_authorized_parties.iter().any(|p| p == azp) {
                    return Err(bad("unauthorized party"));
                }
            }
        }
        if data.claims.sub.is_empty() {
            return Err(bad("token has no subject"));
        }
        Ok(data.claims.sub)
    }
}

/// User ids end up in object keys / logs; keep them boring.
fn valid_user_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:@".contains(&b))
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let header = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .ok_or_else(|| AppError::Unauthorized("missing Authorization header".into()))?;
        let token = header
            .strip_prefix("Bearer ")
            .or_else(|| header.strip_prefix("bearer "))
            .ok_or_else(|| AppError::Unauthorized("expected Bearer token".into()))?
            .trim();

        let user_id = if let Some(dev) = token.strip_prefix("dev:") {
            if !state.config.auth_dev {
                return Err(AppError::Unauthorized("invalid token".into()));
            }
            if !valid_user_id(dev) {
                return Err(AppError::Unauthorized("invalid dev user id".into()));
            }
            dev.to_string()
        } else {
            let sub = state.jwks.verify(token, &state.config).await?;
            if !valid_user_id(&sub) {
                return Err(AppError::Unauthorized("invalid subject".into()));
            }
            sub
        };

        state.ensure_user(&user_id).await?;
        Ok(AuthUser { user_id })
    }
}
