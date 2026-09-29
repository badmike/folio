#![allow(dead_code)]
use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use folio_server::ai::{AiProvider, MockProvider};
use folio_server::auth::JwksCache;
use folio_server::config::Config;
use folio_server::{build_router, db, storage, AppState};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

pub struct TestApp {
    pub router: Router,
    pub state: AppState,
    pub mock: Arc<MockProvider>,
    pub _dir: tempfile::TempDir,
}

pub fn base_config(dir: &std::path::Path) -> Config {
    let mut m: HashMap<String, String> = HashMap::new();
    m.insert(
        "DATABASE_URL".into(),
        format!("sqlite://{}/test.db", dir.display()),
    );
    m.insert(
        "FOLIO_ASSETS_DIR".into(),
        dir.join("assets").display().to_string(),
    );
    m.insert("FOLIO_AUTH_DEV".into(), "true".into());
    Config::from_map(&m).unwrap()
}

impl TestApp {
    pub async fn new() -> Self {
        Self::with(|_| {}).await
    }

    pub async fn with(tweak: impl FnOnce(&mut Config)) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = base_config(dir.path());
        tweak(&mut cfg);
        Self::build(dir, cfg, JwksCache::new(None)).await
    }

    pub async fn build(dir: tempfile::TempDir, cfg: Config, jwks: JwksCache) -> Self {
        let pool = db::connect(&cfg.database_url).await.unwrap();
        let store = storage::build(&cfg.storage).unwrap();
        let mock = Arc::new(MockProvider::with_default(
            r#"{"text":"Hallo Welt","confidence":0.93}"#,
        ));
        let ai: Arc<dyn AiProvider> = mock.clone();
        let state = AppState::new(pool, cfg, store, ai, jwks);
        Self {
            router: build_router(state.clone()),
            state,
            mock,
            _dir: dir,
        }
    }

    pub async fn send(&self, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let res = self.router.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        (status, headers, body)
    }

    pub async fn json(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut b = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            b = b.header("authorization", format!("Bearer {t}"));
        }
        let req = match body {
            Some(v) => b
                .header("content-type", "application/json")
                .body(Body::from(v.to_string()))
                .unwrap(),
            None => b.body(Body::empty()).unwrap(),
        };
        let (s, _, bytes) = self.send(req).await;
        (s, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    pub async fn raw(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        ct: &str,
        body: Vec<u8>,
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", ct)
            .body(Body::from(body))
            .unwrap();
        self.send(req).await
    }
}

pub fn dev(user: &str) -> String {
    format!("dev:{user}")
}
