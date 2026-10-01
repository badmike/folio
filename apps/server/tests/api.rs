mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use common::{dev, TestApp};
use serde_json::{json, Value};

async fn push(app: &TestApp, user: &str, doc: &str, data: &[u8]) -> i64 {
    let (s, v) = app
        .json(
            "POST",
            "/api/sync/push",
            Some(&dev(user)),
            Some(json!({"docId": doc, "deviceId": "d1", "update": B64.encode(data)})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    v["seq"].as_i64().unwrap()
}

async fn pull(app: &TestApp, user: &str, q: &str) -> Value {
    let (s, v) = app
        .json(
            "GET",
            &format!("/api/sync/pull?{q}"),
            Some(&dev(user)),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    v
}

fn upd(v: &Value) -> Vec<Vec<u8>> {
    v["updates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| B64.decode(u["update"].as_str().unwrap()).unwrap())
        .collect()
}

#[tokio::test]
async fn health_is_public() {
    let app = TestApp::new().await;
    let (s, v) = app.json("GET", "/health", None, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["status"], "ok");
    assert!(v["version"].is_string());
}

#[tokio::test]
async fn serves_web_app_and_runtime_config() {
    let web = tempfile::tempdir().unwrap();
    std::fs::write(web.path().join("index.html"), "<!doctype html>folio").unwrap();
    std::fs::create_dir(web.path().join("assets")).unwrap();
    std::fs::write(web.path().join("assets/app-abc.js"), "1").unwrap();
    let dir = web.path().to_path_buf();
    let app = TestApp::with(|c| {
        c.web_dir = Some(dir);
        c.clerk_publishable_key = Some("pk_test_x".into());
    })
    .await;

    let (s, v) = app.json("GET", "/config.json", None, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["apiBase"], "/api");
    assert_eq!(v["clerkPublishableKey"], "pk_test_x");

    let get = |uri: &str| Request::builder().uri(uri).body(Body::empty()).unwrap();
    let (s, h, body) = app.send(get("/notebook/123")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body, b"<!doctype html>folio");
    assert_eq!(h["cache-control"], "no-cache");

    let (s, h, _) = app.send(get("/assets/app-abc.js")).await;
    assert_eq!(s, StatusCode::OK);
    assert!(h["cache-control"].to_str().unwrap().contains("immutable"));

    // unknown API routes stay JSON 404s instead of falling through to the app
    let (s, v) = app.json("GET", "/api/nope", None, None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(v["error"], "not_found");
}

#[tokio::test]
async fn rejects_missing_or_bad_auth() {
    let app = TestApp::new().await;
    let (s, v) = app.json("GET", "/api/sync/docs", None, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"], "unauthorized");
    assert!(v["message"].is_string());
    let (s, _) = app
        .json("GET", "/api/sync/docs", Some("garbage"), None)
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = app
        .json("GET", "/api/sync/docs", Some("dev:bad user!"), None)
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn dev_tokens_rejected_when_dev_auth_off() {
    let app = TestApp::with(|c| c.auth_dev = false).await;
    let (s, _) = app
        .json("GET", "/api/sync/docs", Some("dev:alice"), None)
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn push_pull_ordering_and_since() {
    let app = TestApp::new().await;
    let s1 = push(&app, "alice", "workspace", b"one").await;
    let s2 = push(&app, "alice", "workspace", b"two").await;
    let s3 = push(&app, "alice", "workspace", b"three").await;
    assert!(s1 < s2 && s2 < s3);

    let all = pull(&app, "alice", "docId=workspace&since=0").await;
    assert_eq!(
        upd(&all),
        vec![b"one".to_vec(), b"two".to_vec(), b"three".to_vec()]
    );
    assert_eq!(all["latestSeq"], s3);
    assert!(all.get("snapshot").is_none());
    assert_eq!(all["hasMore"], false);

    let after = pull(&app, "alice", &format!("docId=workspace&since={s1}")).await;
    assert_eq!(upd(&after), vec![b"two".to_vec(), b"three".to_vec()]);
    let none = pull(&app, "alice", &format!("docId=workspace&since={s3}")).await;
    assert!(upd(&none).is_empty());

    // Paging
    let p = pull(&app, "alice", "docId=workspace&since=0&limit=2").await;
    assert_eq!(upd(&p).len(), 2);
    assert_eq!(p["hasMore"], true);
    let last = p["updates"][1]["seq"].as_i64().unwrap();
    let p2 = pull(
        &app,
        "alice",
        &format!("docId=workspace&since={last}&limit=2"),
    )
    .await;
    assert_eq!(upd(&p2), vec![b"three".to_vec()]);
    assert_eq!(p2["hasMore"], false);

    // Unknown doc is simply empty
    let e = pull(&app, "alice", "docId=nope").await;
    assert_eq!(e["latestSeq"], 0);
}

#[tokio::test]
async fn docs_list_and_devices() {
    let app = TestApp::new().await;
    push(&app, "alice", "workspace", b"a").await;
    push(&app, "alice", "nb-1", b"b").await;
    push(&app, "bob", "nb-bob", b"c").await;
    let (s, v) = app
        .json("GET", "/api/sync/docs", Some(&dev("alice")), None)
        .await;
    assert_eq!(s, StatusCode::OK);
    let mut ids: Vec<String> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["docId"].as_str().unwrap().to_string())
        .collect();
    ids.sort();
    assert_eq!(ids, vec!["nb-1", "workspace"]);
    assert!(v[0]["latestSeq"].as_i64().unwrap() > 0);
    assert!(v[0]["updatedAt"].as_i64().unwrap() > 0);

    let (s, _) = app
        .json(
            "POST",
            "/api/devices",
            Some(&dev("alice")),
            Some(json!({"deviceId":"d1","name":"iPad"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = app
        .json(
            "POST",
            "/api/devices",
            Some(&dev("alice")),
            Some(json!({"deviceId":"d1","name":"iPad Pro"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = app
        .json(
            "POST",
            "/api/devices",
            Some(&dev("alice")),
            Some(json!({"deviceId":"","name":"x"})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn users_are_isolated() {
    let app = TestApp::new().await;
    push(&app, "alice", "workspace", b"secret").await;
    let bob = pull(&app, "bob", "docId=workspace&since=0").await;
    assert!(upd(&bob).is_empty());
    assert_eq!(bob["latestSeq"], 0);

    // Bob's compaction of Alice's doc id must not touch it (he has no such doc).
    let (s, _) = app
        .json(
            "POST",
            "/api/sync/compact",
            Some(&dev("bob")),
            Some(json!({"docId":"workspace","uptoSeq":1,"snapshot":B64.encode(b"x")})),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let alice = pull(&app, "alice", "docId=workspace&since=0").await;
    assert_eq!(upd(&alice), vec![b"secret".to_vec()]);

    // Assets
    let (s, _, b) = app
        .raw(
            "POST",
            "/api/assets?id=pic1",
            &dev("alice"),
            "image/png",
            vec![1, 2, 3],
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
    let (s, _, _) = app
        .raw("GET", "/api/assets/pic1", &dev("bob"), "x/y", vec![])
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _, _) = app
        .raw("GET", "/api/assets/pic1", &dev("alice"), "x/y", vec![])
        .await;
    assert_eq!(s, StatusCode::OK);
    // Same client asset id for another user is a different asset.
    let (s, _, _) = app
        .raw(
            "POST",
            "/api/assets?id=pic1",
            &dev("bob"),
            "image/jpeg",
            vec![9, 9],
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (_, h, b) = app
        .raw("GET", "/api/assets/pic1", &dev("alice"), "x/y", vec![])
        .await;
    assert_eq!(b, vec![1, 2, 3]);
    assert_eq!(h["content-type"], "image/png");
}

#[tokio::test]
async fn compaction_returns_snapshot_then_later_updates() {
    let app = TestApp::new().await;
    let _s1 = push(&app, "alice", "nb", b"u1").await;
    let s2 = push(&app, "alice", "nb", b"u2").await;
    let s3 = push(&app, "alice", "nb", b"u3").await;

    let (s, v) = app
        .json(
            "POST",
            "/api/sync/compact",
            Some(&dev("alice")),
            Some(json!({"docId":"nb","uptoSeq":s2,"snapshot":B64.encode(b"SNAP12")})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["deletedUpdates"], 2);

    // A fresh client gets the snapshot plus the later update.
    let p = pull(&app, "alice", "docId=nb&since=0").await;
    assert_eq!(p["snapshot"]["uptoSeq"], s2);
    assert_eq!(
        B64.decode(p["snapshot"]["data"].as_str().unwrap()).unwrap(),
        b"SNAP12"
    );
    assert_eq!(upd(&p), vec![b"u3".to_vec()]);
    assert_eq!(p["latestSeq"], s3);

    // A client already past the snapshot only gets updates.
    let p = pull(&app, "alice", &format!("docId=nb&since={s2}")).await;
    assert!(p.get("snapshot").is_none());
    assert_eq!(upd(&p), vec![b"u3".to_vec()]);

    // New pushes still work and are ordered after.
    let s4 = push(&app, "alice", "nb", b"u4").await;
    assert!(s4 > s3);

    // Stale / invalid compactions.
    let (s, _) = app
        .json(
            "POST",
            "/api/sync/compact",
            Some(&dev("alice")),
            Some(json!({"docId":"nb","uptoSeq":s2,"snapshot":B64.encode(b"x")})),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT);
    let (s, _) = app
        .json(
            "POST",
            "/api/sync/compact",
            Some(&dev("alice")),
            Some(json!({"docId":"nb","uptoSeq":s4+100,"snapshot":B64.encode(b"x")})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Second compaction supersedes the first snapshot.
    let (s, _) = app
        .json(
            "POST",
            "/api/sync/compact",
            Some(&dev("alice")),
            Some(json!({"docId":"nb","uptoSeq":s4,"snapshot":B64.encode(b"SNAP-ALL")})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let p = pull(&app, "alice", "docId=nb&since=0").await;
    assert_eq!(p["snapshot"]["uptoSeq"], s4);
    assert_eq!(
        B64.decode(p["snapshot"]["data"].as_str().unwrap()).unwrap(),
        b"SNAP-ALL"
    );
    assert!(upd(&p).is_empty());
}

#[tokio::test]
async fn validation_and_limits() {
    let app = TestApp::with(|c| c.max_update_bytes = 1024).await;
    let t = dev("alice");
    let big = B64.encode(vec![7u8; 2048]);
    let (s, v) = app
        .json(
            "POST",
            "/api/sync/push",
            Some(&t),
            Some(json!({"docId":"w","deviceId":"d","update":big})),
        )
        .await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE, "{v}");
    assert_eq!(v["error"], "payload_too_large");

    // Very large raw body also maps to a JSON 413.
    let huge = json!({"docId":"w","deviceId":"d","update":"A".repeat(200_000)});
    let (s, v) = app
        .json("POST", "/api/sync/push", Some(&t), Some(huge))
        .await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(v["error"], "payload_too_large");

    for (doc, dev_id, upd) in [
        ("../etc", "d", "AAAA"),
        ("", "d", "AAAA"),
        ("w", "d", "!!notbase64"),
        ("w", "d", ""),
    ] {
        let (s, _) = app
            .json(
                "POST",
                "/api/sync/push",
                Some(&t),
                Some(json!({"docId":doc,"deviceId":dev_id,"update":upd})),
            )
            .await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{doc:?} {upd:?}");
    }
    let (s, _) = app
        .json("POST", "/api/sync/push", Some(&t), Some(json!({"nope": 1})))
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = app
        .json("GET", "/api/sync/pull?docId=a%2Fb", Some(&t), None)
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn push_rate_limit() {
    let app = TestApp::with(|c| c.push_rate_per_min = 3).await;
    for _ in 0..3 {
        push(&app, "alice", "w", b"x").await;
    }
    let (s, v) = app
        .json(
            "POST",
            "/api/sync/push",
            Some(&dev("alice")),
            Some(json!({"docId":"w","deviceId":"d","update":B64.encode(b"x")})),
        )
        .await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(v["error"], "rate_limited");
    // other users unaffected
    push(&app, "bob", "w", b"x").await;
}

#[tokio::test]
async fn asset_limits_and_headers() {
    let app = TestApp::with(|c| c.max_asset_bytes = 1000).await;
    let t = dev("alice");
    let (s, _, _) = app
        .raw("POST", "/api/assets", &t, "image/png", vec![0; 2000])
        .await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
    let (s, _, body) = app
        .raw(
            "POST",
            "/api/assets",
            &t,
            "text/html; charset=utf-8",
            b"<script>1</script>".to_vec(),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let id = serde_json::from_slice::<Value>(&body).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (s, h, b) = app
        .raw("GET", &format!("/api/assets/{id}"), &t, "x/y", vec![])
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b, b"<script>1</script>");
    assert_eq!(h["content-type"], "text/html");
    assert_eq!(h["x-content-type-options"], "nosniff");
    assert!(h["content-security-policy"]
        .to_str()
        .unwrap()
        .contains("sandbox"));
    let (s, _, _) = app
        .raw("GET", "/api/assets/missing", &t, "x/y", vec![])
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _, _) = app
        .raw("POST", "/api/assets?id=..%2Fx", &t, "image/png", vec![1])
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

fn png_b64() -> String {
    B64.encode([0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
}

#[tokio::test]
async fn ai_endpoints_with_mock() {
    let app = TestApp::new().await;
    let t = dev("alice");

    let (s, v) = app
        .json(
            "POST",
            "/api/ai/recognize",
            Some(&t),
            Some(json!({"image": png_b64(), "languages": ["de","en"], "hint": "Physik"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["text"], "Hallo Welt");
    assert_eq!(v["confidence"], 0.93);
    {
        let reqs = app.mock.requests.lock().unwrap();
        assert!(reqs[0].image_png_b64.is_some());
        assert!(reqs[0].user_text.contains("de, en"));
        assert!(reqs[0].system.contains("ONLY"));
    }

    app.mock.push_response(Ok("  # Summary\n- a  ".into()));
    let (s, v) = app
        .json(
            "POST",
            "/api/ai/summarize",
            Some(&t),
            Some(json!({"context":"Heading: X\nText: y","kind":"flashcards"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["markdown"], "# Summary\n- a");
    assert!(app.mock.requests.lock().unwrap()[1]
        .user_text
        .contains("Q:"));

    app.mock.push_response(Ok("42".into()));
    let (s, v) = app
        .json(
            "POST",
            "/api/ai/ask",
            Some(&t),
            Some(json!({"question":"What?","context":"ctx"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["markdown"], "42");

    // Validation
    let (s, _) = app
        .json(
            "POST",
            "/api/ai/summarize",
            Some(&t),
            Some(json!({"context":"x","kind":"poem"})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = app
        .json(
            "POST",
            "/api/ai/recognize",
            Some(&t),
            Some(json!({"image": B64.encode(b"not a png")})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = app
        .json(
            "POST",
            "/api/ai/ask",
            None,
            Some(json!({"question":"What?"})),
        )
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // Jobs recorded
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ai_jobs WHERE status = 'ok' AND user_id = 'alice'",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!(n, 3);
}

#[tokio::test]
async fn ai_failure_does_not_consume_quota() {
    let app = TestApp::new().await;
    app.mock.push_response(Err("boom".into()));
    let (s, v) = app
        .json(
            "POST",
            "/api/ai/ask",
            Some(&dev("alice")),
            Some(json!({"question":"q"})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_GATEWAY, "{v}");
    assert_eq!(
        folio_server::routes::ai::used_today(&app.state, "alice")
            .await
            .unwrap(),
        0
    );
    let st: String = sqlx::query_scalar("SELECT status FROM ai_jobs")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(st, "error");
}

#[tokio::test]
async fn ai_quota_exhaustion() {
    let app = TestApp::with(|c| c.ai_daily_quota = 2).await;
    for _ in 0..2 {
        let (s, _) = app
            .json(
                "POST",
                "/api/ai/ask",
                Some(&dev("alice")),
                Some(json!({"question":"q"})),
            )
            .await;
        assert_eq!(s, StatusCode::OK);
    }
    let (s, v) = app
        .json(
            "POST",
            "/api/ai/ask",
            Some(&dev("alice")),
            Some(json!({"question":"q"})),
        )
        .await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(v["error"], "quota_exceeded");
    // Per-user
    let (s, _) = app
        .json(
            "POST",
            "/api/ai/ask",
            Some(&dev("bob")),
            Some(json!({"question":"q"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
}

#[tokio::test]
async fn ai_disabled_returns_503() {
    use std::sync::Arc;
    let dir = tempfile::tempdir().unwrap();
    let cfg = common::base_config(dir.path());
    let mut app = TestApp::build(dir, cfg, folio_server::auth::JwksCache::new(None)).await;
    app.state.ai = Arc::new(folio_server::ai::DisabledProvider);
    app.router = folio_server::build_router(app.state.clone());
    let (s, v) = app
        .json(
            "POST",
            "/api/ai/ask",
            Some(&dev("alice")),
            Some(json!({"question":"q"})),
        )
        .await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(v["message"], "AI not configured");
    assert_eq!(
        folio_server::routes::ai::used_today(&app.state, "alice")
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn unknown_route_is_json_404() {
    let app = TestApp::new().await;
    let (s, v) = app.json("GET", "/nope", None, None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(v["error"], "not_found");
}

#[tokio::test]
async fn cors_preflight_allows_configured_origin_only() {
    use axum::body::Body;
    use axum::http::Request;
    let app = TestApp::with(|c| c.cors_origins = vec!["http://localhost:4173".into()]).await;
    let preflight = |origin: &str| {
        Request::builder()
            .method("OPTIONS")
            .uri("/api/sync/push")
            .header("origin", origin)
            .header("access-control-request-method", "POST")
            .header(
                "access-control-request-headers",
                "authorization,content-type",
            )
            .body(Body::empty())
            .unwrap()
    };
    let (s, h, _) = app.send(preflight("http://localhost:4173")).await;
    assert!(s.is_success(), "{s}");
    assert_eq!(
        h.get("access-control-allow-origin").unwrap(),
        "http://localhost:4173"
    );
    assert!(h
        .get("access-control-allow-headers")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("authorization"));
    let (_, h, _) = app.send(preflight("http://evil.example")).await;
    assert!(h.get("access-control-allow-origin").is_none());
}

#[tokio::test]
async fn realtime_changes_wake_and_catch_up_without_leaking_other_accounts() {
    let app = TestApp::new().await;
    let alice_seq = push(&app, "alice", "alice-notebook", b"secret").await;
    let (_, first) = app
        .json(
            "GET",
            "/api/sync/changes?since=0",
            Some(&dev("alice")),
            None,
        )
        .await;
    assert_eq!(first["cursor"], alice_seq);
    assert_eq!(first["docs"][0]["docId"], "alice-notebook");
    app.state.ensure_user("bob").await.unwrap();
    let poll = app.json("GET", "/api/sync/changes?since=0", Some("dev:bob"), None);
    let edits = async {
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        push(&app, "alice", "another-secret", b"private").await;
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        push(&app, "bob", "presenter", b"stroke").await
    };
    let ((status, changes), bob_seq) =
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            tokio::join!(poll, edits)
        })
        .await
        .unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(changes["cursor"], bob_seq);
    assert_eq!(changes["docs"].as_array().unwrap().len(), 1);
    assert_eq!(changes["docs"][0]["docId"], "presenter");
    // The cursor catches up to pushes made between long-poll requests.
    let next_seq = push(&app, "bob", "presenter", b"next stroke").await;
    let (_, caught_up) = app
        .json(
            "GET",
            &format!("/api/sync/changes?since={bob_seq}"),
            Some("dev:bob"),
            None,
        )
        .await;
    assert_eq!(caught_up["cursor"], next_seq);
    let (status, _) = app.json("GET", "/api/sync/changes", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
