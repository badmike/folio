//! Environment-driven configuration (`FOLIO_` prefix).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct S3Config {
    pub bucket: String,
    pub endpoint: Option<String>,
    pub region: String,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
}

#[derive(Debug, Clone)]
pub enum StorageConfig {
    S3(S3Config),
    Local(PathBuf),
}

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub database_url: String,
    pub cors_origins: Vec<String>,
    pub clerk_jwks_url: Option<String>,
    pub clerk_issuer: Option<String>,
    /// Optional allow-list for the `azp` claim (comma separated origins).
    pub clerk_authorized_parties: Vec<String>,
    pub auth_dev: bool,
    pub storage: StorageConfig,
    pub openrouter_api_key: Option<String>,
    pub openrouter_base_url: String,
    pub ai_model: String,
    pub ai_vision_model: String,
    pub ai_daily_quota: i64,
    pub max_update_bytes: usize,
    pub max_asset_bytes: usize,
    /// Sync pushes allowed per user per minute.
    pub push_rate_per_min: u32,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let vars: HashMap<String, String> = std::env::vars().collect();
        Self::from_map(&vars)
    }

    /// Parses config from an explicit map (testable, no global env access).
    pub fn from_map(v: &HashMap<String, String>) -> anyhow::Result<Self> {
        let get = |k: &str| {
            v.get(k)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let parse_num = |k: &str, d: i64| -> anyhow::Result<i64> {
            match get(k) {
                Some(s) => s
                    .parse()
                    .map_err(|_| anyhow::anyhow!("{k} must be an integer")),
                None => Ok(d),
            }
        };
        let list = |k: &str| -> Vec<String> {
            get(k)
                .map(|s| {
                    s.split(',')
                        .map(|p| p.trim().to_string())
                        .filter(|p| !p.is_empty())
                        .collect()
                })
                .unwrap_or_default()
        };

        let bind = get("FOLIO_BIND")
            .unwrap_or_else(|| "0.0.0.0:8989".into())
            .parse()
            .map_err(|e| anyhow::anyhow!("invalid FOLIO_BIND: {e}"))?;

        let storage = match get("FOLIO_S3_BUCKET") {
            Some(bucket) => StorageConfig::S3(S3Config {
                bucket,
                endpoint: get("FOLIO_S3_ENDPOINT"),
                region: get("FOLIO_S3_REGION").unwrap_or_else(|| "auto".into()),
                access_key_id: get("FOLIO_S3_ACCESS_KEY_ID").or_else(|| get("AWS_ACCESS_KEY_ID")),
                secret_access_key: get("FOLIO_S3_SECRET_ACCESS_KEY")
                    .or_else(|| get("AWS_SECRET_ACCESS_KEY")),
            }),
            None => StorageConfig::Local(PathBuf::from(
                get("FOLIO_ASSETS_DIR").unwrap_or_else(|| "data/assets".into()),
            )),
        };

        let ai_model =
            get("FOLIO_AI_MODEL").unwrap_or_else(|| "anthropic/claude-sonnet-5.5".into());
        let clerk_issuer = get("CLERK_ISSUER").or_else(|| get("FOLIO_CLERK_ISSUER"));
        let clerk_jwks_url = get("CLERK_JWKS_URL")
            .or_else(|| get("FOLIO_CLERK_JWKS_URL"))
            .or_else(|| {
                clerk_issuer
                    .as_ref()
                    .map(|i| format!("{}/.well-known/jwks.json", i.trim_end_matches('/')))
            });

        Ok(Self {
            bind,
            database_url: get("DATABASE_URL")
                .or_else(|| get("FOLIO_DATABASE_URL"))
                .unwrap_or_else(|| "sqlite://data/folio.db".into()),
            cors_origins: list("FOLIO_CORS_ORIGINS"),
            clerk_jwks_url,
            clerk_issuer,
            clerk_authorized_parties: list("FOLIO_CLERK_AUTHORIZED_PARTIES"),
            auth_dev: get("FOLIO_AUTH_DEV")
                .map(|s| matches!(s.as_str(), "true" | "1" | "yes"))
                .unwrap_or(false),
            storage,
            openrouter_api_key: get("OPENROUTER_API_KEY"),
            openrouter_base_url: get("OPENROUTER_BASE_URL")
                .unwrap_or_else(|| "https://openrouter.ai/api/v1".into()),
            ai_vision_model: get("FOLIO_AI_VISION_MODEL").unwrap_or_else(|| ai_model.clone()),
            ai_model,
            ai_daily_quota: parse_num("FOLIO_AI_DAILY_QUOTA", 200)?,
            max_update_bytes: parse_num("FOLIO_MAX_UPDATE_BYTES", 8 * 1024 * 1024)? as usize,
            max_asset_bytes: parse_num("FOLIO_MAX_ASSET_BYTES", 25 * 1024 * 1024)? as usize,
            push_rate_per_min: parse_num("FOLIO_PUSH_RATE_PER_MIN", 600)? as u32,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults() {
        let c = Config::from_map(&HashMap::new()).unwrap();
        assert_eq!(c.bind.port(), 8989);
        assert_eq!(c.ai_model, "anthropic/claude-sonnet-5.5");
        assert_eq!(c.ai_vision_model, "anthropic/claude-sonnet-5.5");
        assert!(matches!(c.storage, StorageConfig::Local(_)));
        assert!(!c.auth_dev);
        assert_eq!(c.ai_daily_quota, 200);
    }

    #[test]
    fn s3_and_issuer() {
        let m: HashMap<String, String> = [
            ("FOLIO_S3_BUCKET", "b"),
            ("FOLIO_S3_ENDPOINT", "http://minio:9000"),
            ("CLERK_ISSUER", "https://x.clerk.accounts.dev/"),
            ("FOLIO_AUTH_DEV", "true"),
        ]
        .into_iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
        let c = Config::from_map(&m).unwrap();
        assert!(matches!(c.storage, StorageConfig::S3(_)));
        assert_eq!(
            c.clerk_jwks_url.as_deref(),
            Some("https://x.clerk.accounts.dev/.well-known/jwks.json")
        );
        assert!(c.auth_dev);
    }
}
