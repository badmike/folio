//! OpenRouterProvider against a local fake chat completions API (retry/backoff + request shape).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use folio_server::ai::{AiProvider, AiRequest, OpenRouterProvider};
use serde_json::{json, Value};

#[derive(Clone)]
struct Fake {
    hits: Arc<AtomicUsize>,
    fail_first: usize,
    fail_status: u16,
    seen: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
}

async fn completions(
    State(f): State<Fake>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let n = f.hits.fetch_add(1, Ordering::SeqCst);
    f.seen.lock().unwrap().push((headers, body));
    if n < f.fail_first {
        return (
            StatusCode::from_u16(f.fail_status).unwrap(),
            Json(json!({"error":"x"})),
        );
    }
    (
        StatusCode::OK,
        Json(
            json!({"choices":[{"message":{"role":"assistant","content":"hello"}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}),
        ),
    )
}

async fn serve(fake: Fake) -> String {
    let app = Router::new()
        .route("/chat/completions", post(completions))
        .with_state(fake);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    format!("http://{addr}")
}

fn req() -> AiRequest {
    AiRequest {
        system: "sys".into(),
        user_text: "hi".into(),
        image_png_b64: Some("AAAA".into()),
        max_tokens: 50,
    }
}

fn fake(fail_first: usize, status: u16) -> Fake {
    Fake {
        hits: Arc::new(AtomicUsize::new(0)),
        fail_first,
        fail_status: status,
        seen: Arc::new(Mutex::new(vec![])),
    }
}

#[tokio::test]
async fn retries_on_overload_then_succeeds() {
    let f = fake(2, 503);
    let url = serve(f.clone()).await;
    let p = OpenRouterProvider::new(
        "key123".into(),
        url,
        "text-model".into(),
        "vision-model".into(),
    )
    .with_backoff(Duration::from_millis(5));
    let r = p.complete(req()).await.unwrap();
    assert_eq!(r.text, "hello");
    assert_eq!((r.tokens_in, r.tokens_out), (7, 3));
    assert_eq!(f.hits.load(Ordering::SeqCst), 3);
    let seen = f.seen.lock().unwrap();
    assert_eq!(seen[0].0["authorization"], "Bearer key123");
    assert_eq!(seen[0].1["model"], "vision-model");
    assert_eq!(seen[0].1["messages"][0]["content"], "sys");
}

#[tokio::test]
async fn gives_up_after_max_attempts_and_does_not_retry_4xx() {
    let f = fake(100, 500);
    let url = serve(f.clone()).await;
    let p = OpenRouterProvider::new("k".into(), url, "m".into(), "m".into())
        .with_backoff(Duration::from_millis(1));
    assert!(p.complete(req()).await.is_err());
    assert_eq!(f.hits.load(Ordering::SeqCst), 4);

    let f = fake(100, 400);
    let url = serve(f.clone()).await;
    let p = OpenRouterProvider::new("k".into(), url, "m".into(), "m".into())
        .with_backoff(Duration::from_millis(1));
    assert!(p.complete(req()).await.is_err());
    assert_eq!(f.hits.load(Ordering::SeqCst), 1);
}
