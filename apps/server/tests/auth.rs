//! Sign-in against a local OpenID Connect provider, and the session cookie it starts.

mod common;

use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64U, Engine};
use common::{dev, TestApp};
use folio_server::auth;
use folio_server::config::OidcConfig;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::traits::PublicKeyParts;
use rsa::RsaPrivateKey;
use serde_json::{json, Value};

const KEY: &str = include_str!("fixtures/test_rsa_a.pem");
const ORIGIN: &str = "http://folio.test";
const DAY_MS: i64 = 86_400_000;

fn now() -> i64 {
    folio_server::util::now_ms()
}

/// What the provider puts into the next ID token.
#[derive(Clone)]
struct Provider {
    issuer: String,
    claims: Arc<Mutex<Value>>,
}

async fn spawn_provider() -> Provider {
    async fn discovery(State(p): State<Provider>) -> Json<Value> {
        let iss = &p.issuer;
        Json(json!({
            "issuer": iss,
            "authorization_endpoint": format!("{iss}/authorize"),
            "token_endpoint": format!("{iss}/token"),
            "jwks_uri": format!("{iss}/jwks"),
            "response_types_supported": ["code"],
            "subject_types_supported": ["public"],
            "id_token_signing_alg_values_supported": ["RS256"],
        }))
    }
    async fn jwks() -> Json<Value> {
        let k = RsaPrivateKey::from_pkcs1_pem(KEY).unwrap();
        Json(json!({"keys": [{
            "kty": "RSA", "use": "sig", "alg": "RS256", "kid": "a",
            "n": B64U.encode(k.n().to_bytes_be()), "e": B64U.encode(k.e().to_bytes_be()),
        }]}))
    }
    async fn token(State(p): State<Provider>) -> Json<Value> {
        let mut h = Header::new(Algorithm::RS256);
        h.kid = Some("a".into());
        let claims = p.claims.lock().unwrap().clone();
        let key = EncodingKey::from_rsa_pem(KEY.as_bytes()).unwrap();
        let id_token = encode(&h, &claims, &key).unwrap();
        Json(json!({"access_token": "at", "token_type": "Bearer", "id_token": id_token}))
    }

    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let p = Provider {
        issuer: format!("http://{}", l.local_addr().unwrap()),
        claims: Arc::default(),
    };
    let app = Router::new()
        .route("/.well-known/openid-configuration", get(discovery))
        .route("/jwks", get(jwks))
        .route("/token", post(token))
        .with_state(p.clone());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    p
}

async fn app_with(p: &Provider) -> TestApp {
    TestApp::with(|c| {
        c.oidc = Some(OidcConfig {
            issuer: p.issuer.clone(),
            client_id: "folio".into(),
            client_secret: "secret".into(),
            public_origin: ORIGIN.into(),
        })
    })
    .await
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|v| v.split(';').next()?.strip_prefix(&format!("{name}=")))
        .filter(|v| !v.is_empty())
        .map(|v| format!("{name}={v}"))
}

fn location(headers: &HeaderMap) -> String {
    headers[header::LOCATION].to_str().unwrap().to_string()
}

fn get_req(uri: &str, cookie: &str) -> Request<Body> {
    Request::builder()
        .uri(uri)
        .header("cookie", cookie)
        .body(Body::empty())
        .unwrap()
}

/// Runs login and callback for `sub`. Returns the callback's redirect target and session cookie.
async fn sign_in(app: &TestApp, p: &Provider, sub: &str) -> (String, Option<String>) {
    let (s, h, _) = app.send(get_req("/api/auth/login", "")).await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    let pending = cookie(&h, "folio_signin").unwrap();
    let authorize = openidconnect::url::Url::parse(&location(&h)).unwrap();
    let param = |k: &str| {
        let (_, v) = authorize.query_pairs().find(|(n, _)| n == k).unwrap();
        v.to_string()
    };
    assert_eq!(param("redirect_uri"), format!("{ORIGIN}/api/auth/callback"));
    assert_eq!(param("code_challenge_method"), "S256");

    *p.claims.lock().unwrap() = json!({
        "iss": p.issuer, "sub": sub, "aud": "folio", "nonce": param("nonce"),
        "iat": now() / 1000, "exp": now() / 1000 + 300,
        "email": format!("{sub}@example.com"), "name": "Ada Lovelace",
    });
    let uri = format!("/api/auth/callback?code=c&state={}", param("state"));
    let (s, h, _) = app.send(get_req(&uri, &pending)).await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    (location(&h), cookie(&h, "folio_session"))
}

async fn session(app: &TestApp, cookie: &str) -> Value {
    let (s, _, body) = app.send(get_req("/api/auth/session", cookie)).await;
    assert_eq!(s, StatusCode::OK);
    serde_json::from_slice(&body).unwrap()
}

async fn register_device(app: &TestApp, cookie: &str, origin: Option<&str>) -> StatusCode {
    let mut b = Request::builder()
        .method("POST")
        .uri("/api/devices")
        .header("cookie", cookie)
        .header("content-type", "application/json");
    if let Some(o) = origin {
        b = b.header("origin", o);
    }
    let body = json!({"deviceId": "d1", "name": "iPad"}).to_string();
    app.send(b.body(Body::from(body)).unwrap()).await.0
}

#[tokio::test]
async fn sign_in_starts_a_session_and_logout_ends_it() {
    let p = spawn_provider().await;
    let app = app_with(&p).await;
    assert_eq!(
        session(&app, "").await,
        json!({"available": true, "user": null})
    );

    let (to, cookie) = sign_in(&app, &p, "ada").await;
    assert_eq!(to, format!("{ORIGIN}/"));
    let cookie = cookie.unwrap();
    let user = session(&app, &cookie).await["user"].clone();
    assert_eq!(user["name"], "Ada Lovelace");
    assert_eq!(user["email"], "ada@example.com");

    // The same provider account maps to the same folio account on every sign-in.
    let (_, again) = sign_in(&app, &p, "ada").await;
    assert_eq!(
        session(&app, &again.unwrap()).await["user"]["id"],
        user["id"]
    );
    let (_, other) = sign_in(&app, &p, "grace").await;
    assert_ne!(
        session(&app, &other.unwrap()).await["user"]["id"],
        user["id"]
    );

    let logout = Request::builder()
        .method("POST")
        .uri("/api/auth/logout")
        .header("cookie", &cookie)
        .header("origin", ORIGIN)
        .body(Body::empty())
        .unwrap();
    assert_eq!(app.send(logout).await.0, StatusCode::OK);
    assert!(session(&app, &cookie).await["user"].is_null());
}

#[tokio::test]
async fn callback_rejects_a_state_it_did_not_issue() {
    let p = spawn_provider().await;
    let app = app_with(&p).await;
    let (_, h, _) = app.send(get_req("/api/auth/login", "")).await;
    let pending = cookie(&h, "folio_signin").unwrap();

    let uri = "/api/auth/callback?code=c&state=forged";
    let (s, h, _) = app.send(get_req(uri, &pending)).await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    assert_eq!(location(&h), format!("{ORIGIN}/?signin=failed"));
    assert!(cookie(&h, "folio_session").is_none());
}

#[tokio::test]
async fn cookie_writes_need_the_app_origin() {
    let p = spawn_provider().await;
    let app = app_with(&p).await;
    let (_, cookie) = sign_in(&app, &p, "ada").await;
    let cookie = cookie.unwrap();

    assert_eq!(
        register_device(&app, &cookie, Some(ORIGIN)).await,
        StatusCode::OK
    );
    for origin in [Some("http://evil.folio.test"), None] {
        assert_eq!(
            register_device(&app, &cookie, origin).await,
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn sessions_extend_on_use_and_expire_without_it() {
    let p = spawn_provider().await;
    let app = app_with(&p).await;
    let token = auth::create_session(&app.state.db, "u_1", 90)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, created_at) VALUES ('u_1', 0)")
        .execute(&app.state.db)
        .await
        .unwrap();
    let cookie = format!("folio_session={token}");
    let set_expiry = |at: i64| {
        sqlx::query("UPDATE sessions SET expires_at = ?")
            .bind(at)
            .execute(&app.state.db)
    };

    set_expiry(now() + DAY_MS).await.unwrap();
    assert_eq!(session(&app, &cookie).await["user"]["id"], "u_1");
    let (expires_at,): (i64,) = sqlx::query_as("SELECT expires_at FROM sessions")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert!(expires_at > now() + 89 * DAY_MS);

    set_expiry(now() - 1).await.unwrap();
    assert!(session(&app, &cookie).await["user"].is_null());
}

#[tokio::test]
async fn dev_tokens_need_the_dev_flag() {
    let app = TestApp::with(|c| c.auth_dev = false).await;
    let (s, _) = app
        .json("GET", "/api/sync/docs", Some(&dev("alice")), None)
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = app.json("GET", "/api/sync/docs", None, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}
