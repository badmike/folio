//! Environment-driven configuration (`FOLIO_` prefix).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;

use serde::Deserialize;

use crate::ai::Usage;

/// A model choice offered in the composer. Prices are USD per million tokens.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiPreset {
    pub id: String,
    pub label: String,
    pub hint: String,
    /// OpenRouter slug.
    pub model: String,
    pub vision: bool,
    pub input_price: f64,
    pub output_price: f64,
    pub cached_input_price: f64,
}

impl AiPreset {
    /// USD cost of one call: the provider's reported cost, else tokens × preset prices.
    /// `prompt_tokens` includes the cached tokens.
    pub fn cost(&self, u: &Usage) -> f64 {
        if let Some(cost) = u.cost {
            return cost;
        }
        let fresh = (u.prompt_tokens - u.cached_tokens).max(0) as f64;
        (fresh * self.input_price
            + u.cached_tokens as f64 * self.cached_input_price
            + u.completion_tokens as f64 * self.output_price)
            / 1_000_000.0
    }
}

/// OpenRouter prices as of 2026-10-27.
fn default_presets() -> Vec<AiPreset> {
    let preset = |id: &str, label: &str, hint: &str, model: &str, prices: [f64; 3]| AiPreset {
        id: id.into(),
        label: label.into(),
        hint: hint.into(),
        model: model.into(),
        vision: true,
        input_price: prices[0],
        output_price: prices[1],
        cached_input_price: prices[2],
    };
    vec![
        preset(
            "fast",
            "Fast",
            "Quick edits and answers",
            HAIKU,
            [0.1, 0.5, 0.01],
        ),
        preset(
            "smart",
            "Smart",
            "Balanced for most work",
            "anthropic/claude-sonnet-5.5",
            [2.0, 10.0, 0.1],
        ),
        preset(
            "deep",
            "Deep",
            "Hard problems and big diagrams",
            "anthropic/claude-opus-5.5",
            [4.0, 20.0, 0.2],
        ),
    ]
}

const HAIKU: &str = "anthropic/claude-haiku-5.5";

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
    /// Handed to the web app via `/config.json` so it can load Clerk.
    pub clerk_publishable_key: Option<String>,
    pub auth_dev: bool,
    /// Built web app to serve at `/` (with the API under `/api`). `None` = API only.
    pub web_dir: Option<PathBuf>,
    pub storage: StorageConfig,
    pub openrouter_api_key: Option<String>,
    pub openrouter_base_url: String,
    pub ai_presets: Vec<AiPreset>,
    pub ai_default_preset: String,
    /// Writes thread titles. Not charged against the user's credit.
    pub ai_title_model: String,
    /// Per user and UTC day.
    pub ai_daily_credit_usd: f64,
    /// Model calls per turn (answers to `ask_user` don't count).
    pub ai_max_steps: i64,
    /// Input plus output tokens per turn.
    pub ai_max_turn_tokens: i64,
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

        let ai_presets: Vec<AiPreset> = match get("FOLIO_AI_PRESETS") {
            Some(s) => serde_json::from_str(&s)
                .map_err(|e| anyhow::anyhow!("invalid FOLIO_AI_PRESETS: {e}"))?,
            None => default_presets(),
        };
        let ai_default_preset = get("FOLIO_AI_DEFAULT_PRESET").unwrap_or_else(|| "smart".into());
        validate_presets(&ai_presets, &ai_default_preset)?;
        let ai_daily_credit_usd = match get("FOLIO_AI_DAILY_CREDIT_USD") {
            Some(s) => s
                .parse::<f64>()
                .ok()
                .filter(|c| c.is_finite() && *c >= 0.0)
                .ok_or_else(|| {
                    anyhow::anyhow!("FOLIO_AI_DAILY_CREDIT_USD must be a number >= 0")
                })?,
            None => 1.0,
        };
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
            clerk_publishable_key: get("FOLIO_CLERK_PUBLISHABLE_KEY"),
            web_dir: get("FOLIO_WEB_DIR").map(PathBuf::from),
            auth_dev: get("FOLIO_AUTH_DEV")
                .map(|s| matches!(s.as_str(), "true" | "1" | "yes"))
                .unwrap_or(false),
            storage,
            openrouter_api_key: get("OPENROUTER_API_KEY"),
            openrouter_base_url: get("OPENROUTER_BASE_URL")
                .unwrap_or_else(|| "https://openrouter.ai/api/v1".into()),
            ai_presets,
            ai_default_preset,
            ai_title_model: get("FOLIO_AI_TITLE_MODEL").unwrap_or_else(|| HAIKU.into()),
            ai_daily_credit_usd,
            ai_max_steps: parse_num("FOLIO_AI_MAX_STEPS", 25)?,
            ai_max_turn_tokens: parse_num("FOLIO_AI_MAX_TURN_TOKENS", 2_000_000)?,
            max_update_bytes: parse_num("FOLIO_MAX_UPDATE_BYTES", 8 * 1024 * 1024)? as usize,
            max_asset_bytes: parse_num("FOLIO_MAX_ASSET_BYTES", 25 * 1024 * 1024)? as usize,
            push_rate_per_min: parse_num("FOLIO_PUSH_RATE_PER_MIN", 600)? as u32,
        })
    }

    pub fn preset(&self, id: &str) -> Option<&AiPreset> {
        self.ai_presets.iter().find(|p| p.id == id)
    }

    pub fn default_preset(&self) -> &AiPreset {
        self.preset(&self.ai_default_preset)
            .expect("default preset is validated at startup")
    }
}

fn validate_presets(presets: &[AiPreset], default: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!presets.is_empty(), "FOLIO_AI_PRESETS must not be empty");
    for (i, p) in presets.iter().enumerate() {
        anyhow::ensure!(
            !p.id.is_empty() && !p.model.is_empty(),
            "AI preset #{i} needs an id and a model"
        );
        anyhow::ensure!(
            presets[..i].iter().all(|q| q.id != p.id),
            "duplicate AI preset id {}",
            p.id
        );
        anyhow::ensure!(
            [p.input_price, p.output_price, p.cached_input_price]
                .iter()
                .all(|v| v.is_finite() && *v >= 0.0),
            "AI preset {} has an invalid price",
            p.id
        );
    }
    anyhow::ensure!(
        presets.iter().any(|p| p.id == default),
        "FOLIO_AI_DEFAULT_PRESET {default} is not a preset"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults() {
        let c = Config::from_map(&HashMap::new()).unwrap();
        assert_eq!(c.bind.port(), 8989);
        assert_eq!(c.default_preset().model, "anthropic/claude-sonnet-5.5");
        assert_eq!(c.ai_title_model, "anthropic/claude-haiku-5.5");
        assert_eq!(c.ai_daily_credit_usd, 1.0);
        assert!(matches!(c.storage, StorageConfig::Local(_)));
        assert!(!c.auth_dev);
    }

    #[test]
    fn preset_override_and_cost() {
        let m: HashMap<String, String> = [
            (
                "FOLIO_AI_PRESETS",
                r#"[{"id":"x","label":"X","hint":"h","model":"m/x","vision":false,"inputPrice":1,"outputPrice":4,"cachedInputPrice":0.1}]"#,
            ),
            ("FOLIO_AI_DEFAULT_PRESET", "x"),
        ]
        .into_iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
        let c = Config::from_map(&m).unwrap();
        let usage = Usage {
            prompt_tokens: 1_000_000,
            completion_tokens: 500_000,
            cached_tokens: 400_000,
            cost: None,
        };
        assert!((c.default_preset().cost(&usage) - (0.6 + 0.04 + 2.0)).abs() < 1e-9);
        let reported = Usage {
            cost: Some(0.25),
            ..usage
        };
        assert_eq!(c.default_preset().cost(&reported), 0.25);

        let mut bad = m.clone();
        bad.insert("FOLIO_AI_DEFAULT_PRESET".into(), "smart".into());
        assert!(Config::from_map(&bad).is_err());
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
