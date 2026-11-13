//! Passkey accounts end to end, against a software authenticator: invites, sign-in,
//! recovery codes, admin resets and the session cookie.

mod common;

use axum::body::Body;
use axum::http::{header, HeaderMap, Request, StatusCode};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64U, Engine};
use common::{dev, TestApp};
use folio_server::config::AccountsConfig;
use folio_server::{accounts, auth};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const ORIGIN: &str = "http://localhost:5173";
const DAY_MS: i64 = 86_400_000;

fn now() -> i64 {
    folio_server::util::now_ms()
}

/// A passkey held by the test: an ES256 key, its credential id and the user handle it carries.
struct SoftPasskey {
    key: SigningKey,
    id: Vec<u8>,
    user_handle: Vec<u8>,
    counter: u32,
}

fn cbor_bytes(out: &mut Vec<u8>, b: &[u8]) {
    match b.len() {
        n if n < 24 => out.push(0x40 | n as u8),
        n if n < 256 => out.extend([0x58, n as u8]),
        n => out.extend([0x59, (n >> 8) as u8, n as u8]),
    }
    out.extend_from_slice(b);
}

fn client_data(kind: &str, challenge: &Value) -> Vec<u8> {
    json!({ "type": kind, "challenge": challenge, "origin": ORIGIN, "crossOrigin": false })
        .to_string()
        .into_bytes()
}

/// Flags: user present, user verified, and on registration attested credential data.
fn auth_data(flags: u8, counter: u32) -> Vec<u8> {
    let mut d = Sha256::digest(b"localhost").to_vec();
    d.push(flags);
    d.extend(counter.to_be_bytes());
    d
}

impl SoftPasskey {
    /// Answers `navigator.credentials.create` options with a "none" attestation.
    fn create(options: &Value) -> (Self, Value) {
        let pk = &options["publicKey"];
        let key = SigningKey::from_slice(&rand::random::<[u8; 32]>()).unwrap();
        let id = rand::random::<[u8; 16]>().to_vec();
        let user_handle = B64U.decode(pk["user"]["id"].as_str().unwrap()).unwrap();

        let point = key.verifying_key().to_sec1_point(false);
        let xy = &point.as_bytes()[1..];
        let mut cose = vec![0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21];
        cbor_bytes(&mut cose, &xy[..32]);
        cose.push(0x22);
        cbor_bytes(&mut cose, &xy[32..]);

        let mut data = auth_data(0x45, 0);
        data.extend([0; 16]);
        data.extend((id.len() as u16).to_be_bytes());
        data.extend(&id);
        data.extend(cose);
        let mut attestation = vec![0xa3, 0x63];
        attestation.extend(b"fmt");
        attestation.push(0x64);
        attestation.extend(b"none");
        attestation.push(0x67);
        attestation.extend(b"attStmt");
        attestation.extend([0xa0, 0x68]);
        attestation.extend(b"authData");
        cbor_bytes(&mut attestation, &data);

        let credential = json!({
            "id": B64U.encode(&id), "rawId": B64U.encode(&id), "type": "public-key",
            "response": {
                "attestationObject": B64U.encode(attestation),
                "clientDataJSON": B64U.encode(client_data("webauthn.create", &pk["challenge"])),
            },
        });
        let passkey = Self {
            key,
            id,
            user_handle,
            counter: 0,
        };
        (passkey, credential)
    }

    /// Answers `navigator.credentials.get` options.
    fn get(&mut self, options: &Value) -> Value {
        self.counter += 1;
        let data = auth_data(0x05, self.counter);
        let client = client_data("webauthn.get", &options["publicKey"]["challenge"]);
        let mut signed = data.clone();
        signed.extend(Sha256::digest(&client));
        let signature: Signature = self.key.sign(&signed);
        json!({
            "id": B64U.encode(&self.id), "rawId": B64U.encode(&self.id), "type": "public-key",
            "response": {
                "authenticatorData": B64U.encode(data),
                "clientDataJSON": B64U.encode(client),
                "signature": B64U.encode(signature.to_der().as_bytes()),
                "userHandle": B64U.encode(&self.user_handle),
            },
        })
    }
}

async fn app() -> TestApp {
    TestApp::with(|c| {
        c.accounts = Some(AccountsConfig {
            public_origin: ORIGIN.into(),
            rp_id: "localhost".into(),
        })
    })
    .await
}

fn session_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|v| v.split(';').next()?.strip_prefix("folio_session="))
        .filter(|v| !v.is_empty())
        .map(|v| format!("folio_session={v}"))
}

/// A browser request from the app's origin. Returns the status, session cookie and body.
async fn call(
    app: &TestApp,
    method: &str,
    uri: &str,
    cookie: &str,
    body: Option<Value>,
) -> (StatusCode, Option<String>, Value) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("cookie", cookie)
        .header("origin", ORIGIN)
        .header("content-type", "application/json");
    let body = body.map_or(Body::empty(), |b| Body::from(b.to_string()));
    let (s, h, bytes) = app.send(req.body(body).unwrap()).await;
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (s, session_cookie(&h), json)
}

async fn token(app: &TestApp, user_id: Option<&str>) -> String {
    let path = accounts::create_link(&app.state.db, user_id).await.unwrap();
    path.split('=').nth(1).unwrap().to_string()
}

/// Registers a passkey through the API: from a link with `token`, or for the signed-in `cookie`.
async fn register(
    app: &TestApp,
    cookie: &str,
    token: Option<&str>,
) -> (StatusCode, Option<String>, Value, Option<SoftPasskey>) {
    let start = json!({ "token": token, "name": "Ada" });
    let (s, _, res) = call(
        app,
        "POST",
        "/api/auth/passkey/register/start",
        cookie,
        Some(start),
    )
    .await;
    if s != StatusCode::OK {
        return (s, None, res, None);
    }
    let (passkey, credential) = SoftPasskey::create(&res["options"]);
    let finish = json!({ "ceremony": res["ceremony"], "credential": credential });
    let (s, cookie, res) = call(
        app,
        "POST",
        "/api/auth/passkey/register/finish",
        cookie,
        Some(finish),
    )
    .await;
    (s, cookie, res, Some(passkey))
}

async fn sign_in(app: &TestApp, passkey: &mut SoftPasskey) -> (StatusCode, Option<String>, Value) {
    let (_, _, res) = call(app, "POST", "/api/auth/passkey/login/start", "", None).await;
    let finish = json!({ "ceremony": res["ceremony"], "credential": passkey.get(&res["options"]) });
    call(
        app,
        "POST",
        "/api/auth/passkey/login/finish",
        "",
        Some(finish),
    )
    .await
}

async fn session_user(app: &TestApp, cookie: &str) -> Value {
    call(app, "GET", "/api/auth/session", cookie, None).await.2["user"].clone()
}

/// Creates an account from an invite. Returns its cookie, recovery codes and passkey.
async fn invited(app: &TestApp) -> (String, Vec<String>, SoftPasskey) {
    let invite = token(app, None).await;
    let (s, cookie, res, passkey) = register(app, "", Some(&invite)).await;
    assert_eq!(s, StatusCode::OK, "{res}");
    let codes = serde_json::from_value(res["recoveryCodes"].clone()).unwrap();
    (cookie.unwrap(), codes, passkey.unwrap())
}

#[tokio::test]
async fn an_invite_creates_one_account_that_signs_in_with_its_passkey() {
    let app = app().await;
    assert_eq!(
        call(&app, "GET", "/api/auth/session", "", None).await.2,
        json!({"available": true, "user": null})
    );
    let invite = token(&app, None).await;
    let (s, cookie, res, passkey) = register(&app, "", Some(&invite)).await;
    assert_eq!(s, StatusCode::OK, "{res}");
    assert_eq!(res["recoveryCodes"].as_array().unwrap().len(), 10);
    let user = session_user(&app, &cookie.unwrap()).await;
    assert_eq!(user["name"], "Ada");

    // The link is single use, and made-up tokens don't start a registration.
    for t in [invite.as_str(), "forged"] {
        assert_eq!(
            register(&app, "", Some(t)).await.0,
            StatusCode::UNAUTHORIZED
        );
    }

    let mut passkey = passkey.unwrap();
    let (s, cookie, res) = sign_in(&app, &mut passkey).await;
    assert_eq!(s, StatusCode::OK, "{res}");
    assert_eq!(res["user"]["id"], user["id"]);
    let cookie = cookie.unwrap();

    // A second passkey; the last one can't be removed.
    assert_eq!(register(&app, &cookie, None).await.0, StatusCode::OK);
    let (_, _, account) = call(&app, "GET", "/api/auth/account", &cookie, None).await;
    let ids: Vec<&str> = account["passkeys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 2);
    let delete = |id: &str| format!("/api/auth/passkeys/{id}");
    assert_eq!(
        call(&app, "DELETE", &delete(ids[0]), &cookie, None).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "DELETE", &delete(ids[1]), &cookie, None).await.0,
        StatusCode::CONFLICT
    );

    let (s, _, _) = call(&app, "POST", "/api/auth/logout", &cookie, None).await;
    assert_eq!(s, StatusCode::OK);
    assert!(session_user(&app, &cookie).await.is_null());
}

#[tokio::test]
async fn a_recovery_code_signs_in_once() {
    let app = app().await;
    let (cookie, codes, _) = invited(&app).await;
    let user = session_user(&app, &cookie).await;

    let typed = codes[0].to_lowercase().replace('-', "");
    let (s, recovered, _) = call(
        &app,
        "POST",
        "/api/auth/recover",
        "",
        Some(json!({ "code": typed })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        session_user(&app, &recovered.unwrap()).await["id"],
        user["id"]
    );
    let (s, _, _) = call(
        &app,
        "POST",
        "/api/auth/recover",
        "",
        Some(json!({ "code": codes[0] })),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    let (_, _, account) = call(&app, "GET", "/api/auth/account", &cookie, None).await;
    assert_eq!(account["recoveryCodesLeft"], 9);
    let (_, _, fresh) = call(&app, "POST", "/api/auth/recovery-codes", &cookie, None).await;
    assert_eq!(fresh["recoveryCodes"].as_array().unwrap().len(), 10);
    let (s, _, _) = call(
        &app,
        "POST",
        "/api/auth/recover",
        "",
        Some(json!({ "code": codes[1] })),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_admin_reset_replaces_passkeys_codes_and_sessions() {
    let app = app().await;
    let (cookie, codes, mut old) = invited(&app).await;
    let user = session_user(&app, &cookie).await;
    let user_id = user["id"].as_str().unwrap();

    let reset = token(&app, Some(user_id)).await;
    let (s, fresh, res, new) = register(&app, "", Some(&reset)).await;
    assert_eq!(s, StatusCode::OK, "{res}");
    assert_eq!(session_user(&app, &fresh.unwrap()).await["id"], user["id"]);
    assert_ne!(res["recoveryCodes"][0], json!(codes[0]));

    assert!(session_user(&app, &cookie).await.is_null());
    assert_eq!(sign_in(&app, &mut old).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(sign_in(&app, &mut new.unwrap()).await.0, StatusCode::OK);
    let (s, _, _) = call(
        &app,
        "POST",
        "/api/auth/recover",
        "",
        Some(json!({ "code": codes[0] })),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn cookie_writes_need_the_app_origin() {
    let app = app().await;
    let (cookie, _, _) = invited(&app).await;
    let register_device = |origin: Option<&'static str>| {
        let mut b = Request::builder()
            .method("POST")
            .uri("/api/devices")
            .header("cookie", &cookie)
            .header("content-type", "application/json");
        if let Some(o) = origin {
            b = b.header("origin", o);
        }
        let body = json!({"deviceId": "d1", "name": "iPad"}).to_string();
        app.send(b.body(Body::from(body)).unwrap())
    };

    assert_eq!(register_device(Some(ORIGIN)).await.0, StatusCode::OK);
    for origin in [Some("http://evil.localhost:5173"), None] {
        assert_eq!(register_device(origin).await.0, StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn sessions_extend_on_use_and_expire_without_it() {
    let app = app().await;
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
    assert_eq!(session_user(&app, &cookie).await["id"], "u_1");
    let (expires_at,): (i64,) = sqlx::query_as("SELECT expires_at FROM sessions")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert!(expires_at > now() + 89 * DAY_MS);

    set_expiry(now() - 1).await.unwrap();
    assert!(session_user(&app, &cookie).await.is_null());
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
