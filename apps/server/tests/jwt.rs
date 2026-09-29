//! Clerk-style JWT verification against a locally generated RSA key served as JWKS.

mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64U, Engine};
use common::{base_config, TestApp};
use folio_server::auth::JwksCache;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::traits::PublicKeyParts;
use rsa::RsaPrivateKey;
use serde_json::{json, Value};

const KEY_A: &str = include_str!("fixtures/test_rsa_a.pem");
const KEY_B: &str = include_str!("fixtures/test_rsa_b.pem");
const ISS: &str = "https://clerk.test.example";

fn jwk(pem: &str, kid: &str) -> Value {
    let k = RsaPrivateKey::from_pkcs1_pem(pem).unwrap();
    json!({"kty":"RSA","use":"sig","alg":"RS256","kid":kid,
           "n": B64U.encode(k.n().to_bytes_be()), "e": B64U.encode(k.e().to_bytes_be())})
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn token(pem: &str, kid: &str, claims: Value) -> String {
    let mut h = Header::new(Algorithm::RS256);
    h.kid = Some(kid.into());
    encode(
        &h,
        &claims,
        &EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap(),
    )
    .unwrap()
}

fn good_claims(sub: &str) -> Value {
    json!({"sub": sub, "iss": ISS, "exp": now() + 300, "nbf": now() - 10, "azp": "https://app.example"})
}

#[derive(Clone)]
struct JwksServer {
    doc: Arc<std::sync::Mutex<Value>>,
    rotated: Arc<AtomicBool>,
}

async fn spawn_jwks(initial: Value) -> (String, JwksServer) {
    let s = JwksServer {
        doc: Arc::new(std::sync::Mutex::new(initial)),
        rotated: Arc::new(AtomicBool::new(false)),
    };
    async fn h(State(s): State<JwksServer>) -> Json<Value> {
        s.rotated.store(true, Ordering::SeqCst);
        Json(s.doc.lock().unwrap().clone())
    }
    let app = Router::new()
        .route("/jwks.json", get(h))
        .with_state(s.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (format!("http://{addr}/jwks.json"), s)
}

async fn app_with(
    jwks: JwksCache,
    tweak: impl FnOnce(&mut folio_server::config::Config),
) -> TestApp {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = base_config(dir.path());
    cfg.auth_dev = false;
    cfg.clerk_issuer = Some(ISS.into());
    tweak(&mut cfg);
    TestApp::build(dir, cfg, jwks).await
}

async fn status(app: &TestApp, tok: &str) -> StatusCode {
    app.json("GET", "/sync/docs", Some(tok), None).await.0
}

#[tokio::test]
async fn verifies_tokens_and_upserts_user() {
    let (url, _s) = spawn_jwks(json!({"keys":[jwk(KEY_A, "kid-a")]})).await;
    let app = app_with(JwksCache::new(Some(url)), |_| {}).await;

    assert_eq!(
        status(&app, &token(KEY_A, "kid-a", good_claims("user_abc"))).await,
        StatusCode::OK
    );
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = 'user_abc'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(n, 1);

    // expired
    let mut c = good_claims("u");
    c["exp"] = json!(now() - 3600);
    assert_eq!(
        status(&app, &token(KEY_A, "kid-a", c)).await,
        StatusCode::UNAUTHORIZED
    );
    // not yet valid
    let mut c = good_claims("u");
    c["nbf"] = json!(now() + 3600);
    assert_eq!(
        status(&app, &token(KEY_A, "kid-a", c)).await,
        StatusCode::UNAUTHORIZED
    );
    // wrong issuer
    let mut c = good_claims("u");
    c["iss"] = json!("https://evil.example");
    assert_eq!(
        status(&app, &token(KEY_A, "kid-a", c)).await,
        StatusCode::UNAUTHORIZED
    );
    // signed by a different key but claiming the known kid
    assert_eq!(
        status(&app, &token(KEY_B, "kid-a", good_claims("u"))).await,
        StatusCode::UNAUTHORIZED
    );
    // unknown kid
    assert_eq!(
        status(&app, &token(KEY_A, "nope", good_claims("u"))).await,
        StatusCode::UNAUTHORIZED
    );
    // HS256 / alg confusion
    let hs = encode(
        &Header::new(Algorithm::HS256),
        &good_claims("u"),
        &EncodingKey::from_secret(b"x"),
    )
    .unwrap();
    assert_eq!(status(&app, &hs).await, StatusCode::UNAUTHORIZED);
    // dev tokens are not accepted
    assert_eq!(status(&app, "dev:alice").await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn refreshes_jwks_on_unknown_kid() {
    let (url, srv) = spawn_jwks(json!({"keys":[jwk(KEY_A, "kid-a")]})).await;
    let app = app_with(
        JwksCache::new(Some(url)).with_min_refetch(Duration::from_millis(0)),
        |_| {},
    )
    .await;
    assert_eq!(
        status(&app, &token(KEY_A, "kid-a", good_claims("u1"))).await,
        StatusCode::OK
    );
    // Key rotation at the IdP.
    *srv.doc.lock().unwrap() = json!({"keys":[jwk(KEY_A, "kid-a"), jwk(KEY_B, "kid-b")]});
    assert_eq!(
        status(&app, &token(KEY_B, "kid-b", good_claims("u2"))).await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn azp_allow_list_and_static_jwks() {
    let jwks = JwksCache::from_static(&json!({"keys":[jwk(KEY_A, "kid-a")]}).to_string()).unwrap();
    let app = app_with(jwks, |c| {
        c.clerk_authorized_parties = vec!["https://app.example".into()]
    })
    .await;
    assert_eq!(
        status(&app, &token(KEY_A, "kid-a", good_claims("u"))).await,
        StatusCode::OK
    );
    let mut c = good_claims("u");
    c["azp"] = json!("https://other.example");
    assert_eq!(
        status(&app, &token(KEY_A, "kid-a", c)).await,
        StatusCode::UNAUTHORIZED
    );
    // azp absent is fine
    let mut c = good_claims("u");
    c.as_object_mut().unwrap().remove("azp");
    assert_eq!(
        status(&app, &token(KEY_A, "kid-a", c)).await,
        StatusCode::OK
    );
}
