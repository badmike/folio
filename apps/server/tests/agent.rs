//! The AI V2 agent endpoints against the scripted mock provider.

mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::{dev, TestApp};
use folio_server::ai::{ChatDelta, ChatMessage, ContentPart, MockChat};
use serde_json::{json, Value};

fn env() -> Value {
    json!({
        "notebookId": "nb1",
        "notebookTitle": "Physics",
        "pageId": "p1",
        "viewport": {"x": 0, "y": 0, "w": 800, "h": 600},
        "outline": "h1 o1 \"Waves\" at (10, 10, 200, 40)",
    })
}

fn msg(text: &str) -> Value {
    json!({"text": text, "attachments": [], "context": []})
}

fn result(id: &str, output: Value) -> Value {
    json!({"toolCallId": id, "output": output, "isError": false, "effects": []})
}

async fn new_thread(app: &TestApp, user: &str, notebook: Option<&str>) -> String {
    let (s, v) = app
        .json(
            "POST",
            "/api/ai/threads",
            Some(&dev(user)),
            Some(json!({"notebookId": notebook})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["title"], "New thread");
    v["id"].as_str().unwrap().to_string()
}

/// Posts and reads the SSE events, or the JSON error for a non-200 answer.
async fn sse(app: &TestApp, uri: &str, user: &str, body: Value) -> (StatusCode, Vec<Value>) {
    let (s, _, bytes) = app
        .raw(
            "POST",
            uri,
            &dev(user),
            "application/json",
            body.to_string().into_bytes(),
        )
        .await;
    let text = String::from_utf8(bytes).unwrap();
    if s != StatusCode::OK {
        return (s, vec![serde_json::from_str(&text).unwrap()]);
    }
    let events = text
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .map(|d| serde_json::from_str(d).unwrap())
        .collect();
    (s, events)
}

async fn start(app: &TestApp, user: &str, thread: &str, text: &str) -> Vec<Value> {
    let body =
        json!({"message": msg(text), "presetId": "smart", "deviceId": "d1", "environment": env()});
    let (s, ev) = sse(app, &format!("/api/ai/threads/{thread}/turns"), user, body).await;
    assert_eq!(s, StatusCode::OK, "{ev:?}");
    ev
}

async fn step(app: &TestApp, turn: &str, device: &str, results: Value) -> (StatusCode, Vec<Value>) {
    let body = json!({"deviceId": device, "results": results, "environment": env()});
    sse(app, &format!("/api/ai/turns/{turn}/step"), "alice", body).await
}

fn turn_id(events: &[Value]) -> String {
    events[0]["turn"]["id"].as_str().unwrap().to_string()
}

fn step_end(events: &[Value]) -> &str {
    events.last().unwrap()["status"].as_str().unwrap()
}

fn of_type<'a>(events: &'a [Value], ty: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["type"] == ty).collect()
}

async fn detail(app: &TestApp, thread: &str) -> Value {
    let (s, v) = app
        .json(
            "GET",
            &format!("/api/ai/threads/{thread}"),
            Some(&dev("alice")),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    v
}

fn texts(m: &ChatMessage) -> String {
    match m {
        ChatMessage::User(parts) => parts
            .iter()
            .filter_map(|p| match p {
                ContentPart::Text(t) => Some(t.as_str()),
                ContentPart::Image { .. } => None,
            })
            .collect(),
        ChatMessage::Assistant { text, .. } => text.clone(),
        ChatMessage::Tool { content, .. } => content.clone(),
    }
}

#[tokio::test]
async fn tool_loop_over_two_steps() {
    let app = TestApp::new().await;
    let thread = new_thread(&app, "alice", Some("nb1")).await;
    app.mock.push_chat(MockChat::tools(&[(
        "c1",
        "create_text",
        json!({"text": "Hi"}),
    )]));
    app.mock.push_chat(MockChat::text("Done."));

    let ev = start(&app, "alice", &thread, "Write hi").await;
    assert_eq!(ev[0]["userItem"]["kind"], "user");
    assert_eq!(ev[0]["turn"]["status"], "running");
    let calls = of_type(&ev, "item");
    assert_eq!(calls[0]["item"]["kind"], "tool_call");
    assert_eq!(calls[0]["item"]["payload"]["input"]["text"], "Hi");
    // 1000 input and 100 output tokens at $2 and $10 per million
    let usage = of_type(&ev, "usage");
    assert!((usage[0]["credit"]["usedUsd"].as_f64().unwrap() - 0.003).abs() < 1e-9);
    assert_eq!(step_end(&ev), "tool_calls");

    let effects =
        json!([{"notebookId": "nb1", "ops": [{"op": "add"}], "inverse": [{"op": "remove"}]}]);
    let mut res = result("c1", json!({"ids": ["o9"]}));
    res["effects"] = effects.clone();
    let (s, ev) = step(&app, &turn_id(&ev), "d1", json!([res])).await;
    assert_eq!(s, StatusCode::OK, "{ev:?}");
    assert_eq!(of_type(&ev, "text_delta")[0]["delta"], "Done.");
    assert_eq!(step_end(&ev), "done");

    let req = app.mock.chat_requests.lock().unwrap()[1].clone();
    let n = req.messages.len();
    assert!(
        matches!(&req.messages[n - 3], ChatMessage::Assistant { tool_calls, .. } if tool_calls[0].id == "c1")
    );
    assert!(texts(&req.messages[n - 2]).contains("o9"));
    assert!(texts(&req.messages[n - 1]).contains("Physics"));
    assert_eq!(req.cache_breakpoint, Some(n - 2));

    let d = detail(&app, &thread).await;
    let kinds: Vec<&str> = d["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["user", "tool_call", "tool_result", "assistant"]);
    assert_eq!(d["items"][2]["payload"]["effects"], effects);
    assert_eq!(d["turns"][0]["status"], "done");
    assert_eq!(d["turns"][0]["steps"], 2);

    // The cheap model titles the thread in the background.
    for _ in 0..50 {
        if detail(&app, &thread).await["thread"]["title"] == "Mock title" {
            // Thinking could use up the small budget, and the model must title, not answer.
            let title = app.mock.title_requests.lock().unwrap()[0].clone();
            assert!(!title.reasoning);
            assert!(texts(&title.messages[0]).starts_with("<message>\n"));
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("thread was not titled");
}

#[tokio::test]
async fn only_the_turn_device_posts_results() {
    let app = TestApp::new().await;
    let thread = new_thread(&app, "alice", Some("nb1")).await;
    app.mock
        .push_chat(MockChat::tools(&[("c1", "list_pages", json!({}))]));
    let turn = turn_id(&start(&app, "alice", &thread, "Pages?").await);

    let (s, v) = step(&app, &turn, "d2", json!([result("c1", json!([]))])).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(v[0]["error"], "not_turn_device");
    let (s, _) = step(&app, &turn, "d1", json!([result("other", json!([]))])).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (s, ev) = step(&app, &turn, "d1", json!([result("c1", json!([]))])).await;
    assert_eq!((s, step_end(&ev)), (StatusCode::OK, "done"));
    let (s, v) = step(&app, &turn, "d1", json!([])).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(v[0]["error"], "turn_not_awaiting");
}

#[tokio::test]
async fn step_cap_ends_partial_and_ask_user_answers_are_free() {
    let app = TestApp::with(|c| c.ai_max_steps = 1).await;
    let thread = new_thread(&app, "alice", Some("nb1")).await;
    app.mock.push_chat(MockChat::tools(&[(
        "q1",
        "ask_user",
        json!({"question": "Which?"}),
    )]));
    app.mock
        .push_chat(MockChat::tools(&[("c1", "list_pages", json!({}))]));

    let turn = turn_id(&start(&app, "alice", &thread, "Draw something").await);
    assert_eq!(
        detail(&app, &thread).await["thread"]["status"],
        "needs_input"
    );

    let (_, ev) = step(&app, &turn, "d1", json!([result("q1", json!("a tree"))])).await;
    assert_eq!(step_end(&ev), "tool_calls");
    let (_, ev) = step(&app, &turn, "d1", json!([result("c1", json!([]))])).await;
    assert_eq!(step_end(&ev), "partial");

    assert_eq!(app.mock.chat_requests.lock().unwrap().len(), 2);
    let d = detail(&app, &thread).await;
    assert_eq!(d["turns"][0]["status"], "partial");
    assert_eq!(d["turns"][0]["steps"], 1);
    assert_eq!(d["items"].as_array().unwrap().len(), 5);
}

#[tokio::test]
async fn exhausted_credit_ends_the_turn_partial() {
    let app = TestApp::with(|c| c.ai_daily_credit_usd = 0.002).await;
    let thread = new_thread(&app, "alice", Some("nb1")).await;
    app.mock
        .push_chat(MockChat::tools(&[("c1", "list_pages", json!({}))]));
    let turn = turn_id(&start(&app, "alice", &thread, "Pages?").await);

    let (_, ev) = step(&app, &turn, "d1", json!([result("c1", json!([]))])).await;
    assert_eq!(of_type(&ev, "error")[0]["code"], "credit_exhausted");
    assert_eq!(step_end(&ev), "partial");
    assert_eq!(app.mock.chat_requests.lock().unwrap().len(), 1);
    assert_eq!(
        detail(&app, &thread).await["items"][2]["kind"],
        "tool_result"
    );

    let (_, cfg) = app
        .json("GET", "/api/ai/config", Some(&dev("alice")), None)
        .await;
    assert_eq!(cfg["credit"]["limitUsd"], 0.002);
    assert!(cfg["credit"]["usedUsd"].as_f64().unwrap() > 0.002);
    assert_eq!(cfg["defaultPresetId"], "smart");
}

#[tokio::test]
async fn revert_hides_turns_from_history() {
    let app = TestApp::new().await;
    let thread = new_thread(&app, "alice", Some("nb1")).await;
    let first = turn_id(&start(&app, "alice", &thread, "first secret").await);
    start(&app, "alice", &thread, "second").await;

    let (s, d) = app
        .json(
            "POST",
            &format!("/api/ai/turns/{first}/revert"),
            Some(&dev("alice")),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{d}");
    assert_eq!(d["turns"][0]["status"], "reverted");
    assert_eq!(d["turns"][1]["status"], "reverted");

    start(&app, "alice", &thread, "third").await;
    let req = app
        .mock
        .chat_requests
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    let history: String = req.messages.iter().map(texts).collect();
    assert!(history.contains("third"));
    assert!(!history.contains("first secret") && !history.contains("second"));
}

#[tokio::test]
async fn continue_answers_lost_calls_and_runs_the_next_step() {
    let app = TestApp::new().await;
    let thread = new_thread(&app, "alice", Some("nb1")).await;
    app.mock.push_chat(MockChat::tools(&[(
        "c1",
        "move_objects",
        json!({"ids": ["o1"]}),
    )]));
    let turn = turn_id(&start(&app, "alice", &thread, "Move it").await);

    let uri = format!("/api/ai/turns/{turn}/continue");
    let (s, v) = sse(
        &app,
        &uri,
        "alice",
        json!({"deviceId": "d2", "environment": env()}),
    )
    .await;
    assert_eq!(
        (s, v[0]["error"].as_str()),
        (StatusCode::FORBIDDEN, Some("not_turn_device"))
    );
    let (s, ev) = sse(
        &app,
        &uri,
        "alice",
        json!({"deviceId": "d1", "environment": env()}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let lost = &of_type(&ev, "item")[0]["item"];
    assert_eq!(lost["kind"], "tool_result");
    assert_eq!(lost["payload"]["isError"], true);
    assert_eq!(step_end(&ev), "done");

    let req = app.mock.chat_requests.lock().unwrap()[1].clone();
    assert!(req.messages.iter().any(
        |m| matches!(m, ChatMessage::Tool { content, .. } if content.contains("interrupted"))
    ));
}

#[tokio::test]
async fn cancel_aborts_a_streaming_step() {
    let app = TestApp::new().await;
    let thread = new_thread(&app, "alice", Some("nb1")).await;
    app.mock
        .push_chat(MockChat::Stall(vec![ChatDelta::Text("Half an ans".into())]));

    let cancel = async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let turn: String = sqlx::query_scalar("SELECT id FROM ai_turns")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
        app.json(
            "POST",
            &format!("/api/ai/turns/{turn}/cancel"),
            Some(&dev("alice")),
            None,
        )
        .await
    };
    let (ev, (s, turn)) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(start(&app, "alice", &thread, "Long answer"), cancel)
    })
    .await
    .expect("cancel ends the stream");
    assert_eq!(s, StatusCode::OK);
    assert_eq!(turn["status"], "cancelled");
    assert_eq!(step_end(&ev), "cancelled");

    let d = detail(&app, &thread).await;
    assert_eq!(d["turns"][0]["status"], "cancelled");
    assert_eq!(d["items"][1]["payload"]["text"], "Half an ans");
    // No usage chunk arrived: the step is charged an estimate from the prompt and the text.
    assert!(d["turns"][0]["tokensIn"].as_i64().unwrap() > 1000);
    assert_eq!(d["turns"][0]["tokensOut"], 2);
    assert!(d["turns"][0]["costUsd"].as_f64().unwrap() > 0.0);
}

#[tokio::test]
async fn results_of_a_stopped_turn_are_kept_without_a_step() {
    let app = TestApp::new().await;
    let thread = new_thread(&app, "alice", Some("nb1")).await;
    app.mock.push_chat(MockChat::tools(&[
        ("c1", "create_text", json!({"text": "Hi"})),
        ("c2", "create_text", json!({"text": "Ho"})),
    ]));
    let turn = turn_id(&start(&app, "alice", &thread, "Write").await);
    let (s, _) = app
        .json(
            "POST",
            &format!("/api/ai/turns/{turn}/cancel"),
            Some(&dev("alice")),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);

    let effects = json!([{"notebookId": "nb1", "ops": [], "inverse": []}]);
    let mut res = result("c1", json!({"ids": ["o9"]}));
    res["effects"] = effects.clone();
    let uri = format!("/api/ai/turns/{turn}/results");
    let alice = dev("alice");
    let post = |device: &str| {
        let body = json!({"deviceId": device, "results": [res.clone()]});
        app.json("POST", &uri, Some(&alice), Some(body))
    };
    assert_eq!(post("d2").await.0, StatusCode::FORBIDDEN);
    assert_eq!(post("d1").await.0, StatusCode::NO_CONTENT);
    assert_eq!(post("d1").await.0, StatusCode::BAD_REQUEST);

    let d = detail(&app, &thread).await;
    assert_eq!(d["turns"][0]["status"], "cancelled");
    assert_eq!(d["items"][3]["kind"], "tool_result");
    assert_eq!(d["items"][3]["payload"]["effects"], effects);
    assert_eq!(app.mock.chat_requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn thread_list_search_pin_and_settle() {
    let app = TestApp::new().await;
    let alice = dev("alice");
    let list = |q: &'static str| {
        let app = &app;
        let alice = &alice;
        async move {
            let (s, v) = app
                .json("GET", &format!("/api/ai/threads?{q}"), Some(alice), None)
                .await;
            assert_eq!(s, StatusCode::OK, "{v}");
            v.as_array()
                .unwrap()
                .iter()
                .map(|t| t["id"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        }
    };
    let patch = |id: &str, body: Value| {
        let uri = format!("/api/ai/threads/{id}");
        let app = &app;
        let alice = &alice;
        async move { app.json("PATCH", &uri, Some(alice), Some(body)).await }
    };

    let t2 = new_thread(&app, "alice", Some("nb1")).await;
    let t1 = new_thread(&app, "alice", Some("nb1")).await;
    let lib = new_thread(&app, "alice", None).await;
    new_thread(&app, "bob", Some("nb1")).await;
    start(&app, "alice", &t1, "How does photosynthesis work?").await;
    assert_eq!(list("notebookId=nb1").await, [t1.as_str(), t2.as_str()]);
    assert_eq!(list("notebookId=library").await, [lib.as_str()]);

    // Pinned first; renaming locks the title and is searchable.
    let (s, v) = patch(&t2, json!({"pinKey": "a0", "title": "Lecture notes"})).await;
    assert_eq!((s, &v["pinKey"]), (StatusCode::OK, &json!("a0")));
    assert_eq!(list("notebookId=nb1").await, [t2.as_str(), t1.as_str()]);
    assert_eq!(list("notebookId=nb1&search=PHOTO").await, [t1.as_str()]);
    assert_eq!(list("notebookId=nb1&search=lecture").await, [t2.as_str()]);
    assert_eq!(
        list("notebookId=nb1&search=50%25").await,
        Vec::<String>::new()
    );

    // Manual settle, then a new turn unsettles.
    patch(&t1, json!({"settled": true})).await;
    assert_eq!(list("notebookId=nb1&settled=0").await, [t2.as_str()]);
    assert_eq!(list("notebookId=nb1&settled=1").await, [t1.as_str()]);
    start(&app, "alice", &t1, "One more").await;
    assert_eq!(list("notebookId=nb1&settled=1").await, Vec::<String>::new());

    // Idle for three days: unpinned threads settle, pinned ones stay.
    sqlx::query("UPDATE ai_threads SET last_activity_at = last_activity_at - 4 * 86400000")
        .execute(&app.state.db)
        .await
        .unwrap();
    assert_eq!(list("notebookId=nb1&settled=0").await, [t2.as_str()]);
    assert_eq!(list("notebookId=library&settled=1").await, [lib.as_str()]);
    let (_, v) = patch(&t2, json!({"pinKey": null})).await;
    assert!(v["pinKey"].is_null());

    // Ownership and delete
    let (s, _) = app
        .json(
            "GET",
            &format!("/api/ai/threads/{t1}"),
            Some(&dev("bob")),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = app
        .json(
            "DELETE",
            &format!("/api/ai/threads/{t2}"),
            Some(&alice),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(list("notebookId=nb1").await, [t1.as_str()]);
}

#[tokio::test]
async fn threads_remember_the_prompt_note_that_started_them() {
    let app = TestApp::new().await;
    let alice = dev("alice");
    let (s, v) = app
        .json(
            "POST",
            "/api/ai/threads",
            Some(&alice),
            Some(json!({"notebookId": "nb1", "sourceNote": "stroke-a"})),
        )
        .await;
    assert_eq!((s, &v["sourceNote"]), (StatusCode::OK, &json!("stroke-a")));
    new_thread(&app, "alice", Some("nb1")).await;

    let (_, v) = app
        .json("GET", "/api/ai/threads?notebookId=nb1", Some(&alice), None)
        .await;
    let notes: Vec<&Value> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|t| &t["sourceNote"])
        .collect();
    assert!(notes.contains(&&json!("stroke-a")) && notes.contains(&&Value::Null));

    let (s, _) = app
        .json(
            "POST",
            "/api/ai/threads",
            Some(&alice),
            Some(json!({"notebookId": "nb1", "sourceNote": "has space"})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn instructions_reach_the_system_prompt() {
    let app = TestApp::new().await;
    let t = dev("alice");
    let put = |body: Value| app.json("PUT", "/api/ai/instructions", Some(&t), Some(body));
    let (s, _) = put(json!({"notebookId": null, "text": "Answer in German."})).await;
    assert_eq!(s, StatusCode::OK);
    put(json!({"notebookId": "nb1", "text": " Use metric units. "})).await;
    let (s, v) = put(json!({"notebookId": null, "text": "x".repeat(4001)})).await;
    assert_eq!(
        (s, &v["error"]),
        (StatusCode::BAD_REQUEST, &json!("bad_request"))
    );

    let (_, v) = app
        .json("GET", "/api/ai/instructions?notebookId=nb1", Some(&t), None)
        .await;
    assert_eq!(v, json!({"notebookId": "nb1", "text": "Use metric units."}));

    let thread = new_thread(&app, "alice", Some("nb1")).await;
    start(&app, "alice", &thread, "Hi").await;
    let system = app.mock.chat_requests.lock().unwrap()[0].system.clone();
    assert!(system[0].contains("Never claim an edit"));
    assert!(system[1].contains("Answer in German.") && system[1].contains("Use metric units."));

    put(json!({"notebookId": null, "text": ""})).await;
    let (_, v) = app
        .json("GET", "/api/ai/instructions", Some(&t), None)
        .await;
    assert_eq!(v, json!({"notebookId": null, "text": ""}));
}
