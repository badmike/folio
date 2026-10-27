//! AI provider abstraction. Handlers build prompts; providers only transport them.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::{self, BoxStream};
use futures::StreamExt;
use serde_json::{json, Value};

use crate::error::AppError;

/// One-shot completion (handwriting recognition).
#[derive(Debug, Clone)]
pub struct AiRequest {
    pub model: String,
    pub system: String,
    pub user_text: String,
    /// Base64 PNG, when the request needs vision.
    pub image_png_b64: Option<String>,
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Default)]
pub struct AiResponse {
    pub text: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
}

/// Token counts of one model call. `prompt_tokens` includes `cached_tokens`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Usage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
}

/// A streaming chat call with tools (the agent step).
#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    /// Stable system parts in prompt order. Anthropic models get a cache breakpoint after each.
    pub system: Vec<String>,
    pub messages: Vec<ChatMessage>,
    /// OpenAI `tools` entries.
    pub tools: Vec<Value>,
    pub max_tokens: u32,
    /// Index of the last message of the stable history, cached for the next step.
    pub cache_breakpoint: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChatMessage {
    User(Vec<ContentPart>),
    Assistant {
        text: String,
        tool_calls: Vec<ChatToolCall>,
    },
    Tool {
        tool_call_id: String,
        content: String,
        /// Base64 PNG, sent in a user message after the tool results.
        image: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ContentPart {
    Text(String),
    Image { mime: String, data_b64: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatToolCall {
    pub id: String,
    pub name: String,
    /// JSON text, as the model wrote it.
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChatDelta {
    Text(String),
    /// Emitted complete, once the model finished the call.
    ToolCall(ChatToolCall),
    Usage(Usage),
}

/// Dropping the stream aborts the upstream request.
pub type ChatStream = BoxStream<'static, Result<ChatDelta, AppError>>;

#[async_trait]
pub trait AiProvider: Send + Sync {
    /// Whether requests can actually be served (false => handlers answer 503 up-front).
    fn is_configured(&self) -> bool {
        true
    }
    async fn complete(&self, req: AiRequest) -> Result<AiResponse, AppError>;
    async fn chat(&self, req: ChatRequest) -> Result<ChatStream, AppError>;
}

/// Used when no API key is configured. Never fabricates answers.
pub struct DisabledProvider;

#[async_trait]
impl AiProvider for DisabledProvider {
    fn is_configured(&self) -> bool {
        false
    }
    async fn complete(&self, _req: AiRequest) -> Result<AiResponse, AppError> {
        Err(AppError::AiNotConfigured)
    }
    async fn chat(&self, _req: ChatRequest) -> Result<ChatStream, AppError> {
        Err(AppError::AiNotConfigured)
    }
}

/// Usage reported by every scripted mock chat.
pub const MOCK_USAGE: Usage = Usage {
    prompt_tokens: 1000,
    completion_tokens: 100,
    cached_tokens: 0,
};

/// A scripted chat response for [`MockProvider`].
pub enum MockChat {
    Deltas(Vec<ChatDelta>),
    /// Streams the deltas, then never finishes (cancel tests).
    Stall(Vec<ChatDelta>),
    /// Fails before any byte arrives.
    Fail(String),
}

impl MockChat {
    pub fn text(text: &str) -> Self {
        Self::Deltas(vec![
            ChatDelta::Text(text.into()),
            ChatDelta::Usage(MOCK_USAGE),
        ])
    }

    /// Tool calls as `(id, name, input)`.
    pub fn tools(calls: &[(&str, &str, Value)]) -> Self {
        let mut deltas: Vec<ChatDelta> = calls
            .iter()
            .map(|(id, name, input)| {
                ChatDelta::ToolCall(ChatToolCall {
                    id: id.to_string(),
                    name: name.to_string(),
                    arguments: input.to_string(),
                })
            })
            .collect();
        deltas.push(ChatDelta::Usage(MOCK_USAGE));
        Self::Deltas(deltas)
    }
}

/// Test double: replays queued responses (or a default) and records requests.
/// Chat requests without tools are title requests: they answer `title` and are recorded apart,
/// so the background title call never consumes a scripted step.
/// Must never be constructed by the production binary.
#[derive(Default)]
pub struct MockProvider {
    pub responses: Mutex<Vec<Result<String, String>>>,
    pub requests: Mutex<Vec<AiRequest>>,
    pub default_response: Mutex<Option<String>>,
    pub chats: Mutex<VecDeque<MockChat>>,
    pub chat_requests: Mutex<Vec<ChatRequest>>,
    pub title_requests: Mutex<Vec<ChatRequest>>,
}

impl MockProvider {
    pub fn with_default(text: &str) -> Self {
        let m = Self::default();
        *m.default_response.lock().unwrap() = Some(text.to_string());
        m
    }
    pub fn push_response(&self, r: Result<String, String>) {
        self.responses.lock().unwrap().push(r);
    }
    pub fn push_chat(&self, c: MockChat) {
        self.chats.lock().unwrap().push_back(c);
    }
}

#[async_trait]
impl AiProvider for MockProvider {
    async fn complete(&self, req: AiRequest) -> Result<AiResponse, AppError> {
        self.requests.lock().unwrap().push(req);
        let next = {
            let mut q = self.responses.lock().unwrap();
            if q.is_empty() {
                None
            } else {
                Some(q.remove(0))
            }
        };
        let text = match next {
            Some(Ok(t)) => t,
            Some(Err(e)) => return Err(AppError::Upstream(e)),
            None => self
                .default_response
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_default(),
        };
        Ok(AiResponse {
            text,
            tokens_in: 10,
            tokens_out: 5,
        })
    }

    async fn chat(&self, req: ChatRequest) -> Result<ChatStream, AppError> {
        if req.tools.is_empty() {
            self.title_requests.lock().unwrap().push(req);
            return Ok(stream::iter([Ok(ChatDelta::Text("Mock title".into()))]).boxed());
        }
        self.chat_requests.lock().unwrap().push(req);
        let next = self.chats.lock().unwrap().pop_front();
        Ok(match next.unwrap_or_else(|| MockChat::text("ok")) {
            MockChat::Deltas(d) => stream::iter(d.into_iter().map(Ok)).boxed(),
            MockChat::Stall(d) => stream::iter(d.into_iter().map(Ok))
                .chain(stream::pending())
                .boxed(),
            MockChat::Fail(e) => return Err(AppError::Upstream(e)),
        })
    }
}

/// OpenRouter chat completions client.
pub struct OpenRouterProvider {
    http: reqwest::Client,
    api_key: String,
    base_url: String,
    max_attempts: u32,
    base_backoff: Duration,
}

impl OpenRouterProvider {
    pub fn new(api_key: String, base_url: String) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(120))
            .build()
            .expect("reqwest client");
        Self {
            http,
            api_key,
            base_url: base_url.trim_end_matches('/').to_string(),
            max_attempts: 4,
            base_backoff: Duration::from_millis(500),
        }
    }

    pub fn with_backoff(mut self, base: Duration) -> Self {
        self.base_backoff = base;
        self
    }

    pub fn build_body(&self, req: &AiRequest) -> Value {
        let mut content = Vec::new();
        if let Some(img) = &req.image_png_b64 {
            content.push(json!({
                "type": "image_url",
                "image_url": {"url": format!("data:image/png;base64,{img}")}
            }));
        }
        content.push(json!({"type": "text", "text": req.user_text}));
        json!({
            "model": req.model,
            "max_tokens": req.max_tokens,
            "messages": [
                {"role": "system", "content": req.system},
                {"role": "user", "content": content},
            ],
        })
    }

    fn url(&self) -> String {
        format!("{}/chat/completions", self.base_url)
    }

    fn retryable(status: u16) -> bool {
        status == 429 || (500..600).contains(&status)
    }
}

/// The streaming request body. Anthropic models get `cache_control` breakpoints on the system
/// parts and after the stable history.
pub fn build_chat_body(req: &ChatRequest) -> Value {
    let anthropic = req.model.starts_with("anthropic/");
    let system = if anthropic {
        Value::Array(
            req.system
                .iter()
                .map(|s| json!({"type": "text", "text": s, "cache_control": {"type": "ephemeral"}}))
                .collect(),
        )
    } else {
        Value::String(req.system.join("\n\n"))
    };
    let mut messages = vec![json!({"role": "system", "content": system})];
    let mut cache_at = None;
    let mut i = 0;
    while i < req.messages.len() {
        let group_start = i;
        match &req.messages[i] {
            ChatMessage::User(parts) => {
                let content: Vec<Value> = parts.iter().map(part_json).collect();
                messages.push(json!({"role": "user", "content": content}));
                i += 1;
            }
            ChatMessage::Assistant { text, tool_calls } => {
                let mut m = json!({
                    "role": "assistant",
                    "content": if text.is_empty() { Value::Null } else { json!(text) },
                });
                if !tool_calls.is_empty() {
                    m["tool_calls"] = tool_calls
                        .iter()
                        .map(|c| {
                            json!({
                                "id": c.id,
                                "type": "function",
                                "function": {"name": c.name, "arguments": c.arguments},
                            })
                        })
                        .collect();
                }
                messages.push(m);
                i += 1;
            }
            ChatMessage::Tool { .. } => {
                // The tool role can't hold images: send the run of results, then one user
                // message with their images.
                let mut images = Vec::new();
                while let Some(ChatMessage::Tool {
                    tool_call_id,
                    content,
                    image,
                }) = req.messages.get(i)
                {
                    messages.push(
                        json!({"role": "tool", "tool_call_id": tool_call_id, "content": content}),
                    );
                    if let Some(img) = image {
                        images.push(json!({"type": "text", "text": format!("Image from tool call {tool_call_id}:")}));
                        images.push(part_json(&ContentPart::Image {
                            mime: "image/png".into(),
                            data_b64: img.clone(),
                        }));
                    }
                    i += 1;
                }
                if !images.is_empty() {
                    messages.push(json!({"role": "user", "content": images}));
                }
            }
        }
        if req
            .cache_breakpoint
            .is_some_and(|b| (group_start..i).contains(&b))
        {
            cache_at = Some(messages.len() - 1);
        }
    }
    if let (true, Some(at)) = (anthropic, cache_at) {
        mark_cache(&mut messages[at]);
    }
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "stream": true,
        "stream_options": {"include_usage": true},
        "messages": messages,
    });
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(req.tools.clone());
    }
    body
}

fn part_json(p: &ContentPart) -> Value {
    match p {
        ContentPart::Text(t) => json!({"type": "text", "text": t}),
        ContentPart::Image { mime, data_b64 } => json!({
            "type": "image_url",
            "image_url": {"url": format!("data:{mime};base64,{data_b64}")}
        }),
    }
}

/// Puts a cache breakpoint on the last content part of a message.
fn mark_cache(m: &mut Value) {
    let content = &mut m["content"];
    if let Some(text) = content.as_str().filter(|t| !t.is_empty()) {
        *content = json!([{"type": "text", "text": text}]);
    }
    if let Some(last) = content.as_array_mut().and_then(|a| a.last_mut()) {
        last["cache_control"] = json!({"type": "ephemeral"});
    }
}

/// Parses OpenAI-style SSE chunks: text deltas, and tool-call fragments assembled by index.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    calls: BTreeMap<u64, ChatToolCall>,
    /// `[DONE]` arrived.
    pub done: bool,
}

impl SseParser {
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<ChatDelta>, AppError> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim_end().strip_prefix("data:") else {
                continue; // comments (": OPENROUTER PROCESSING"), event names, blank lines
            };
            let data = data.trim();
            if data == "[DONE]" {
                self.done = true;
                out.extend(self.finish());
                break;
            }
            if data.is_empty() {
                continue;
            }
            let v: Value = serde_json::from_str(data)
                .map_err(|e| AppError::Upstream(format!("invalid stream chunk: {e}")))?;
            self.chunk(&v, &mut out)?;
        }
        Ok(out)
    }

    /// Flushes tool calls still being assembled.
    pub fn finish(&mut self) -> Vec<ChatDelta> {
        std::mem::take(&mut self.calls)
            .into_values()
            .map(|mut c| {
                if c.id.is_empty() {
                    c.id = format!("call_{}", uuid::Uuid::new_v4().simple());
                }
                ChatDelta::ToolCall(c)
            })
            .collect()
    }

    fn chunk(&mut self, v: &Value, out: &mut Vec<ChatDelta>) -> Result<(), AppError> {
        if let Some(err) = v.get("error") {
            let msg = err["message"].as_str().unwrap_or("provider error");
            return Err(AppError::Upstream(format!("provider error: {msg}")));
        }
        let choice = &v["choices"][0];
        let delta = &choice["delta"];
        if let Some(t) = delta["content"].as_str().filter(|t| !t.is_empty()) {
            out.push(ChatDelta::Text(t.to_string()));
        }
        for tc in delta["tool_calls"].as_array().into_iter().flatten() {
            let index = tc["index"].as_u64().unwrap_or(0);
            let call = self.calls.entry(index).or_insert_with(|| ChatToolCall {
                id: String::new(),
                name: String::new(),
                arguments: String::new(),
            });
            if let Some(id) = tc["id"].as_str().filter(|s| !s.is_empty()) {
                call.id = id.to_string();
            }
            if let Some(name) = tc["function"]["name"].as_str().filter(|s| !s.is_empty()) {
                call.name = name.to_string();
            }
            if let Some(args) = tc["function"]["arguments"].as_str() {
                call.arguments.push_str(args);
            }
        }
        if choice["finish_reason"].is_string() {
            out.extend(self.finish());
        }
        if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
            out.push(ChatDelta::Usage(Usage {
                prompt_tokens: u["prompt_tokens"].as_i64().unwrap_or(0),
                completion_tokens: u["completion_tokens"].as_i64().unwrap_or(0),
                cached_tokens: u["prompt_tokens_details"]["cached_tokens"]
                    .as_i64()
                    .unwrap_or(0),
            }));
        }
        Ok(())
    }
}

#[async_trait]
impl AiProvider for OpenRouterProvider {
    async fn complete(&self, req: AiRequest) -> Result<AiResponse, AppError> {
        let body = self.build_body(&req);
        let url = self.url();
        let mut last_err = String::from("unknown");
        for attempt in 0..self.max_attempts {
            if attempt > 0 {
                tokio::time::sleep(self.base_backoff * 2u32.pow(attempt - 1)).await;
            }
            let res = self
                .http
                .post(&url)
                .bearer_auth(&self.api_key)
                .timeout(Duration::from_secs(90))
                .json(&body)
                .send()
                .await;
            let res = match res {
                Ok(r) => r,
                Err(e) => {
                    last_err = format!("request failed: {e}");
                    tracing::warn!(counter = "ai_error", attempt, error = %e, "openrouter request failed");
                    continue;
                }
            };
            let status = res.status().as_u16();
            if status == 200 {
                let v: Value = res
                    .json()
                    .await
                    .map_err(|e| AppError::Upstream(format!("invalid provider response: {e}")))?;
                // OpenRouter reports a failing upstream model as HTTP 200 with an `error` object.
                let Some(text) = v["choices"][0]["message"]["content"].as_str() else {
                    let msg = v["error"]["message"].as_str().unwrap_or("no completion");
                    return Err(AppError::Upstream(format!("provider error: {msg}")));
                };
                return Ok(AiResponse {
                    text: text.to_string(),
                    tokens_in: v["usage"]["prompt_tokens"].as_i64().unwrap_or(0),
                    tokens_out: v["usage"]["completion_tokens"].as_i64().unwrap_or(0),
                });
            }
            last_err = format!("provider returned HTTP {status}");
            tracing::warn!(counter = "ai_error", attempt, status, "openrouter non-200");
            if !Self::retryable(status) {
                break;
            }
        }
        Err(AppError::Upstream(last_err))
    }

    /// Retries only a connection failure before any byte was sent: every other failure may have
    /// reached the model, and an ambiguous call is never repeated.
    async fn chat(&self, req: ChatRequest) -> Result<ChatStream, AppError> {
        let body = build_chat_body(&req);
        let url = self.url();
        let mut attempt = 0;
        let res = loop {
            match self
                .http
                .post(&url)
                .bearer_auth(&self.api_key)
                .json(&body)
                .send()
                .await
            {
                Ok(r) => break r,
                Err(e) if e.is_connect() && attempt + 1 < self.max_attempts => {
                    tracing::warn!(counter = "ai_error", attempt, error = %e, "openrouter connect failed");
                    tokio::time::sleep(self.base_backoff * 2u32.pow(attempt)).await;
                    attempt += 1;
                }
                Err(e) => return Err(AppError::Upstream(format!("request failed: {e}"))),
            }
        };
        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
                .unwrap_or_default();
            tracing::warn!(
                counter = "ai_error",
                status = status.as_u16(),
                "openrouter non-200"
            );
            return Err(AppError::Upstream(format!(
                "provider returned HTTP {}: {msg}",
                status.as_u16()
            )));
        }
        let bytes = res.bytes_stream().boxed();
        let deltas = stream::unfold(Some((bytes, SseParser::default())), |state| async move {
            let (mut bytes, mut parser) = state?;
            loop {
                let batch = match bytes.next().await {
                    Some(Ok(chunk)) => match parser.feed(&chunk) {
                        Ok(d) if d.is_empty() && !parser.done => continue,
                        Ok(d) => d.into_iter().map(Ok).collect(),
                        Err(e) => return Some((vec![Err(e)], None)),
                    },
                    Some(Err(e)) => {
                        let e = AppError::Upstream(format!("stream interrupted: {e}"));
                        return Some((vec![Err(e)], None));
                    }
                    None => return Some((parser.finish().into_iter().map(Ok).collect(), None)),
                };
                let next = (!parser.done).then_some((bytes, parser));
                return Some((batch, next));
            }
        })
        .flat_map(stream::iter);
        Ok(deltas.boxed())
    }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

pub const RECOGNIZE_SYSTEM: &str = "You are a handwriting transcription engine embedded in a note-taking app. \
The image contains handwritten notes (English and/or German, possibly with math or symbols). \
Transcribe exactly what is written, preserving line breaks and German umlauts/ß. \
Do not translate, correct, explain, or add commentary. \
Respond with ONLY a single JSON object of the form {\"text\": \"<transcription>\", \"confidence\": <number between 0 and 1>} \
and nothing else. If the image contains no legible writing, respond with {\"text\": \"\", \"confidence\": 0}.";

pub fn recognize_user_text(languages: &[String], hint: Option<&str>) -> String {
    let langs = if languages.is_empty() {
        "en, de".to_string()
    } else {
        languages.join(", ")
    };
    let mut s = format!("Expected language(s): {langs}. Transcribe the handwriting in the image.");
    if let Some(h) = hint.filter(|h| !h.trim().is_empty()) {
        s.push_str(&format!(
            "\nContext hint (may help disambiguate words; do not include it in the output): {h}"
        ));
    }
    s
}

/// Extracts `{text, confidence}` from a model reply; tolerant of code fences and prose around the JSON.
pub fn parse_recognition(raw: &str) -> (String, f64) {
    let trimmed = raw.trim();
    let candidate = match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(a), Some(b)) if b > a => &trimmed[a..=b],
        _ => "",
    };
    if let Ok(v) = serde_json::from_str::<Value>(candidate) {
        if let Some(t) = v["text"].as_str() {
            let c = v["confidence"].as_f64().unwrap_or(0.5).clamp(0.0, 1.0);
            return (t.to_string(), c);
        }
    }
    // Model ignored the format: treat the whole reply as the transcription with low confidence.
    (trimmed.to_string(), 0.3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_fenced_json() {
        assert_eq!(
            parse_recognition(r#"{"text":"Hallo","confidence":0.9}"#),
            ("Hallo".into(), 0.9)
        );
        let (t, c) = parse_recognition("```json\n{\"text\":\"a\\nb\",\"confidence\":2}\n```");
        assert_eq!((t.as_str(), c), ("a\nb", 1.0));
        let (t, c) = parse_recognition("just words");
        assert_eq!((t.as_str(), c), ("just words", 0.3));
    }

    #[test]
    fn request_body_shape() {
        let p = OpenRouterProvider::new("k".into(), "http://x".into());
        let b = p.build_body(&AiRequest {
            model: "v".into(),
            system: "s".into(),
            user_text: "t".into(),
            image_png_b64: Some("AAAA".into()),
            max_tokens: 10,
        });
        assert_eq!(b["model"], "v");
        assert_eq!(b["messages"][0], json!({"role": "system", "content": "s"}));
        assert_eq!(b["messages"][1]["content"][0]["type"], "image_url");
        assert_eq!(
            b["messages"][1]["content"][0]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );
        assert_eq!(b["messages"][1]["content"][1]["type"], "text");
    }

    #[test]
    fn chat_body_shape() {
        let tool = |id: &str, image: Option<&str>| ChatMessage::Tool {
            tool_call_id: id.into(),
            content: "{}".into(),
            image: image.map(Into::into),
        };
        let mut req = ChatRequest {
            model: "anthropic/claude-sonnet-5.5".into(),
            system: vec!["base".into(), "instructions".into()],
            messages: vec![
                ChatMessage::User(vec![ContentPart::Text("draw".into())]),
                ChatMessage::Assistant {
                    text: String::new(),
                    tool_calls: vec![
                        ChatToolCall {
                            id: "a".into(),
                            name: "look".into(),
                            arguments: "{}".into(),
                        },
                        ChatToolCall {
                            id: "b".into(),
                            name: "list_pages".into(),
                            arguments: "{}".into(),
                        },
                    ],
                },
                tool("a", Some("PNG")),
                tool("b", None),
                ChatMessage::User(vec![ContentPart::Text("env".into())]),
            ],
            tools: vec![json!({"type": "function", "function": {"name": "look"}})],
            max_tokens: 100,
            cache_breakpoint: Some(3),
        };
        let b = build_chat_body(&req);
        assert_eq!(b["stream"], true);
        assert_eq!(b["tools"][0]["function"]["name"], "look");
        let m = b["messages"].as_array().unwrap();
        let roles: Vec<&str> = m.iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(
            roles,
            [
                "system",
                "user",
                "assistant",
                "tool",
                "tool",
                "user",
                "user"
            ]
        );
        assert_eq!(m[0]["content"][1]["cache_control"]["type"], "ephemeral");
        assert_eq!(m[2]["content"], Value::Null);
        assert_eq!(m[2]["tool_calls"][1]["function"]["arguments"], "{}");
        // The image follows both results and carries the history breakpoint.
        assert_eq!(
            m[5]["content"][1]["image_url"]["url"],
            "data:image/png;base64,PNG"
        );
        assert_eq!(m[5]["content"][1]["cache_control"]["type"], "ephemeral");
        assert!(m[6]["content"][0].get("cache_control").is_none());

        req.model = "openai/gpt-x".into();
        let b = build_chat_body(&req);
        assert_eq!(b["messages"][0]["content"], "base\n\ninstructions");
        assert!(!b.to_string().contains("cache_control"));
    }

    #[test]
    fn sse_assembles_tool_calls_by_index() {
        let mut p = SseParser::default();
        let chunks = [
            ": OPENROUTER PROCESSING\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hi \"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"look\",\"arguments\":\"{\\\"a\\\"\"}},{\"index\":1,\"id\":\"c2\",\"function\":{\"name\":\"list_pages\",\"arguments\":\"\"}}]}}]}\n",
            "\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":1}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4,\"prompt_tokens_details\":{\"cached_tokens\":5}}}\n\ndata: [DONE]\n\n",
        ];
        let mut out = Vec::new();
        for c in chunks {
            // split mid-line to exercise buffering
            let (a, b) = c.as_bytes().split_at(c.len() / 2);
            out.extend(p.feed(a).unwrap());
            out.extend(p.feed(b).unwrap());
        }
        let call = |id: &str, name: &str, args: &str| {
            ChatDelta::ToolCall(ChatToolCall {
                id: id.into(),
                name: name.into(),
                arguments: args.into(),
            })
        };
        assert_eq!(
            out,
            vec![
                ChatDelta::Text("Hi ".into()),
                call("c1", "look", r#"{"a":1}"#),
                call("c2", "list_pages", ""),
                ChatDelta::Usage(Usage {
                    prompt_tokens: 9,
                    completion_tokens: 4,
                    cached_tokens: 5
                }),
            ]
        );
        assert!(p.done);
        assert!(p
            .feed(b"data: {\"error\":{\"message\":\"overloaded\"}}\n")
            .is_err());
    }
}
