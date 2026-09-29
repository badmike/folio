//! AI provider abstraction. Handlers build prompts; providers only transport them.

use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::error::AppError;

#[derive(Debug, Clone)]
pub struct AiRequest {
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

#[async_trait]
pub trait AiProvider: Send + Sync {
    /// Whether requests can actually be served (false => handlers answer 503 up-front).
    fn is_configured(&self) -> bool {
        true
    }
    async fn complete(&self, req: AiRequest) -> Result<AiResponse, AppError>;
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
}

/// Test double: replays queued responses (or a default) and records requests.
/// Must never be constructed by the production binary.
#[derive(Default)]
pub struct MockProvider {
    pub responses: Mutex<Vec<Result<String, String>>>,
    pub requests: Mutex<Vec<AiRequest>>,
    pub default_response: Mutex<Option<String>>,
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
}

#[async_trait]
impl AiProvider for MockProvider {
    async fn complete(&self, req: AiRequest) -> Result<AiResponse, AppError> {
        self.requests.lock().unwrap().push(req);
        let next = {
            let mut q = self.responses.lock().unwrap();
            if q.is_empty() { None } else { Some(q.remove(0)) }
        };
        let text = match next {
            Some(Ok(t)) => t,
            Some(Err(e)) => return Err(AppError::Upstream(e)),
            None => self.default_response.lock().unwrap().clone().unwrap_or_default(),
        };
        Ok(AiResponse { text, tokens_in: 10, tokens_out: 5 })
    }
}

/// Anthropic Messages API client with retry/backoff.
pub struct AnthropicProvider {
    http: reqwest::Client,
    api_key: String,
    base_url: String,
    model: String,
    vision_model: String,
    max_attempts: u32,
    base_backoff: Duration,
}

impl AnthropicProvider {
    pub fn new(api_key: String, base_url: String, model: String, vision_model: String) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(90))
            .build()
            .expect("reqwest client");
        Self {
            http,
            api_key,
            base_url: base_url.trim_end_matches('/').to_string(),
            model,
            vision_model,
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
        let model = if let Some(img) = &req.image_png_b64 {
            content.push(json!({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": img}
            }));
            &self.vision_model
        } else {
            &self.model
        };
        content.push(json!({"type": "text", "text": req.user_text}));
        json!({
            "model": model,
            "max_tokens": req.max_tokens,
            "system": req.system,
            "messages": [{"role": "user", "content": content}],
        })
    }

    fn retryable(status: u16) -> bool {
        status == 429 || status == 529 || (500..600).contains(&status)
    }
}

#[async_trait]
impl AiProvider for AnthropicProvider {
    async fn complete(&self, req: AiRequest) -> Result<AiResponse, AppError> {
        let body = self.build_body(&req);
        let url = format!("{}/v1/messages", self.base_url);
        let mut last_err = String::from("unknown");
        for attempt in 0..self.max_attempts {
            if attempt > 0 {
                tokio::time::sleep(self.base_backoff * 2u32.pow(attempt - 1)).await;
            }
            let res = self
                .http
                .post(&url)
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await;
            let res = match res {
                Ok(r) => r,
                Err(e) => {
                    last_err = format!("request failed: {e}");
                    tracing::warn!(counter = "ai_error", attempt, error = %e, "anthropic request failed");
                    continue;
                }
            };
            let status = res.status().as_u16();
            if status == 200 {
                let v: Value = res
                    .json()
                    .await
                    .map_err(|e| AppError::Upstream(format!("invalid provider response: {e}")))?;
                let text: String = v["content"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter(|b| b["type"] == "text")
                            .filter_map(|b| b["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("")
                    })
                    .unwrap_or_default();
                return Ok(AiResponse {
                    text,
                    tokens_in: v["usage"]["input_tokens"].as_i64().unwrap_or(0),
                    tokens_out: v["usage"]["output_tokens"].as_i64().unwrap_or(0),
                });
            }
            last_err = format!("provider returned HTTP {status}");
            tracing::warn!(counter = "ai_error", attempt, status, "anthropic non-200");
            if !Self::retryable(status) {
                break;
            }
        }
        Err(AppError::Upstream(last_err))
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
    let langs = if languages.is_empty() { "en, de".to_string() } else { languages.join(", ") };
    let mut s = format!("Expected language(s): {langs}. Transcribe the handwriting in the image.");
    if let Some(h) = hint.filter(|h| !h.trim().is_empty()) {
        s.push_str(&format!("\nContext hint (may help disambiguate words; do not include it in the output): {h}"));
    }
    s
}

pub const SUMMARIZE_SYSTEM: &str = "You are a study assistant inside a note-taking app. \
You receive the semantic content of the user's notes (headings, text, lists, tables, math, transcribed handwriting). \
Base your output strictly on the provided notes; do not invent facts that are not supported by them. \
Answer in the same language as the notes. Output Markdown only, with no preamble.";

pub fn summarize_instruction(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "page" => "Write a concise summary of this page as Markdown: a one-line title, then short bullet points with the key ideas.",
        "lecture" => "Write structured lecture notes as Markdown: headings per topic, key definitions in bold, and a short list of open questions at the end.",
        "outline" => "Produce a hierarchical outline of the content as nested Markdown bullet lists.",
        "flashcards" => "Create study flashcards from the content. Use Markdown, one card per item in the form:\n**Q:** question\n**A:** answer",
        "questions" => "Write practice questions (mix of recall and understanding) as a numbered Markdown list, followed by an 'Answers' section with brief answers.",
        _ => return None,
    })
}

pub const ASK_SYSTEM: &str = "You answer questions about the user's own notes inside a note-taking app. \
Use the provided notes as your primary source and say so when the notes do not contain the answer. \
Answer in the language of the question. Output Markdown only.";

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
        assert_eq!(parse_recognition(r#"{"text":"Hallo","confidence":0.9}"#), ("Hallo".into(), 0.9));
        let (t, c) = parse_recognition("```json\n{\"text\":\"a\\nb\",\"confidence\":2}\n```");
        assert_eq!((t.as_str(), c), ("a\nb", 1.0));
        let (t, c) = parse_recognition("just words");
        assert_eq!((t.as_str(), c), ("just words", 0.3));
    }

    #[test]
    fn request_body_shape() {
        let p = AnthropicProvider::new("k".into(), "http://x".into(), "m".into(), "v".into());
        let b = p.build_body(&AiRequest {
            system: "s".into(),
            user_text: "t".into(),
            image_png_b64: Some("AAAA".into()),
            max_tokens: 10,
        });
        assert_eq!(b["model"], "v");
        assert_eq!(b["messages"][0]["content"][0]["type"], "image");
        assert_eq!(b["messages"][0]["content"][0]["source"]["media_type"], "image/png");
        assert_eq!(b["messages"][0]["content"][1]["type"], "text");
    }
}
