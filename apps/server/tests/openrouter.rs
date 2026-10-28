//! OpenRouterProvider against a local fake chat completions API (retry/backoff, request shape, streaming).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use folio_server::ai::{
    AiProvider, AiRequest, ChatDelta, ChatMessage, ChatRequest, ContentPart, OpenRouterProvider,
};
use futures::StreamExt;
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
        model: "vision-model".into(),
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
    let p = OpenRouterProvider::new("key123".into(), url).with_backoff(Duration::from_millis(5));
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
    let p = OpenRouterProvider::new("k".into(), url).with_backoff(Duration::from_millis(1));
    assert!(p.complete(req()).await.is_err());
    assert_eq!(f.hits.load(Ordering::SeqCst), 4);

    let f = fake(100, 400);
    let url = serve(f.clone()).await;
    let p = OpenRouterProvider::new("k".into(), url).with_backoff(Duration::from_millis(1));
    assert!(p.complete(req()).await.is_err());
    assert_eq!(f.hits.load(Ordering::SeqCst), 1);
}

async fn stream_completions(State(f): State<Fake>, Json(body): Json<Value>) -> String {
    f.hits.fetch_add(1, Ordering::SeqCst);
    f.seen.lock().unwrap().push((HeaderMap::new(), body));
    [
        r#"{"choices":[{"delta":{"content":"Hal"}}]}"#,
        r#"{"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"c1","function":{"name":"look","arguments":"{\"x\""}}]}}]}"#,
        r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":"tool_calls"}]}"#,
        r#"{"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":6,"cost":0.0031}}"#,
        "[DONE]",
    ]
    .map(|d| format!("data: {d}\n\n"))
    .concat()
}

#[tokio::test]
async fn chat_streams_text_and_tool_calls_without_retrying_failures() {
    let f = fake(0, 200);
    let app = Router::new()
        .route("/chat/completions", post(stream_completions))
        .with_state(f.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    let req = ChatRequest {
        model: "anthropic/claude-haiku-5.5".into(),
        system: vec!["sys".into()],
        messages: vec![ChatMessage::User(vec![ContentPart::Text("hi".into())])],
        tools: vec![json!({"type": "function", "function": {"name": "look"}})],
        max_tokens: 50,
        cache_breakpoint: Some(0),
        reasoning: true,
    };
    let p = OpenRouterProvider::new("k".into(), url).with_backoff(Duration::from_millis(1));
    let deltas: Vec<ChatDelta> = p
        .chat(req.clone())
        .await
        .unwrap()
        .map(Result::unwrap)
        .collect()
        .await;
    let text: String = deltas
        .iter()
        .filter_map(|d| match d {
            ChatDelta::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "Hallo");
    assert!(deltas.iter().any(
        |d| matches!(d, ChatDelta::ToolCall(c) if c.id == "c1" && c.arguments == r#"{"x":1}"#)
    ));
    assert!(
        matches!(deltas.last(), Some(ChatDelta::Usage(u)) if u.prompt_tokens == 20 && u.cost == Some(0.0031))
    );
    assert_eq!(f.seen.lock().unwrap()[0].1["stream"], true);

    // A 503 may have reached the model: it is reported, never retried.
    let f = fake(100, 503);
    let url = serve(f.clone()).await;
    let p = OpenRouterProvider::new("k".into(), url).with_backoff(Duration::from_millis(1));
    assert!(p.chat(req).await.is_err());
    assert_eq!(f.hits.load(Ordering::SeqCst), 1);
}
