//! AI V2 agent: threads, turns and the step loop.
//! Wire types mirror `apps/web/src/ai/protocol.ts`. Change both sides together.

pub mod prompt;
pub mod step;
pub mod store;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// Title of a thread until the auto title (or the user) replaces it.
pub const NEW_THREAD_TITLE: &str = "New thread";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiPreset {
    pub id: String,
    pub label: String,
    pub hint: String,
    pub vision: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiCredit {
    pub limit_usd: f64,
    pub used_usd: f64,
    pub resets_at: i64,
}

impl AiCredit {
    pub fn exhausted(&self) -> bool {
        self.used_usd >= self.limit_usd
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiLimits {
    pub max_steps: i64,
    pub max_tokens_per_turn: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigRes {
    pub presets: Vec<AiPreset>,
    pub default_preset_id: String,
    pub credit: AiCredit,
    pub limits: AiLimits,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
    Idle,
    Running,
    AwaitingTools,
    NeedsInput,
    Failed,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub notebook_id: Option<String>,
    pub title: String,
    pub pin_key: Option<String>,
    pub settled_at: Option<i64>,
    pub last_activity_at: i64,
    pub created_at: i64,
    pub status: ThreadStatus,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadReq {
    pub notebook_id: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateThreadReq {
    pub title: Option<String>,
    /// Outer `None`: unchanged. `Some(None)`: unpin.
    #[serde(default, deserialize_with = "present")]
    pub pin_key: Option<Option<String>>,
    pub settled: Option<bool>,
}

/// Tells a present `null` apart from a missing field.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Serialize, Deserialize, sqlx::Type, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum TurnStatus {
    Running,
    AwaitingTools,
    Done,
    Partial,
    Failed,
    Cancelled,
    Reverted,
}

#[derive(Serialize, sqlx::FromRow, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TurnInfo {
    pub id: String,
    pub thread_id: String,
    pub seq: i64,
    pub status: TurnStatus,
    pub preset_id: String,
    pub device_id: String,
    pub steps: i64,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub cached_tokens: i64,
    pub cost_usd: f64,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThreadItem {
    pub id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub seq: i64,
    #[serde(flatten)]
    pub body: ItemBody,
    pub created_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum ItemBody {
    User(UserMessage),
    Assistant(AssistantText),
    ToolCall(ToolCall),
    ToolResult(ToolResult),
}

impl ItemBody {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::User(_) => "user",
            Self::Assistant(_) => "assistant",
            Self::ToolCall(_) => "tool_call",
            Self::ToolResult(_) => "tool_result",
        }
    }

    pub fn payload_json(&self) -> String {
        match self {
            Self::User(p) => serde_json::to_string(p),
            Self::Assistant(p) => serde_json::to_string(p),
            Self::ToolCall(p) => serde_json::to_string(p),
            Self::ToolResult(p) => serde_json::to_string(p),
        }
        .expect("item payloads serialize")
    }

    pub fn from_db(kind: &str, payload: &str) -> serde_json::Result<Self> {
        Ok(match kind {
            "user" => Self::User(serde_json::from_str(payload)?),
            "assistant" => Self::Assistant(serde_json::from_str(payload)?),
            "tool_call" => Self::ToolCall(serde_json::from_str(payload)?),
            "tool_result" => Self::ToolResult(serde_json::from_str(payload)?),
            other => {
                return Err(serde::de::Error::custom(format!(
                    "unknown item kind {other}"
                )))
            }
        })
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AssistantText {
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetailRes {
    pub thread: ThreadSummary,
    pub turns: Vec<TurnInfo>,
    pub items: Vec<ThreadItem>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ChipKind {
    Page,
    Selection,
    Frame,
    Notebook,
    PromptNote,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ContextChip {
    pub kind: ChipKind,
    pub label: String,
    /// Never interpreted by the server.
    #[serde(rename = "ref")]
    pub reference: Value,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
    pub text: String,
    /// Asset ids from POST /assets.
    pub attachments: Vec<String>,
    pub context: Vec<ContextChip>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub notebook_id: Option<String>,
    pub notebook_title: Option<String>,
    pub page_id: Option<String>,
    /// A `Rect`, rendered as JSON for the model.
    pub viewport: Option<Value>,
    pub outline: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartTurnReq {
    pub message: UserMessage,
    pub preset_id: String,
    pub device_id: String,
    pub environment: Environment,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub tool_call_id: String,
    pub name: String,
    /// Parsed arguments; the raw text when the model wrote invalid JSON.
    pub input: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub tool_call_id: String,
    pub output: Value,
    pub is_error: bool,
    /// Base64 PNG for `look`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// Opaque to the server; stored for revert.
    pub effects: Vec<Value>,
}

/// `deviceId` is not in protocol.ts yet: the server needs it to enforce the turn's device.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StepReq {
    pub device_id: String,
    pub results: Vec<ToolResult>,
    pub environment: Environment,
    pub steer: Option<UserMessage>,
}

/// Body of POST /ai/turns/{id}/results.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResultsReq {
    pub device_id: String,
    pub results: Vec<ToolResult>,
}

/// Body of POST /ai/turns/{id}/continue (not in protocol.ts yet).
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContinueReq {
    pub device_id: String,
    pub environment: Environment,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum AiErrorCode {
    AiNotConfigured,
    CreditExhausted,
    NotTurnDevice,
    TurnNotAwaiting,
    NoVision,
    Upstream,
    BadRequest,
}

/// `step_end.status`: `tool_calls` or the turn status the step ended with.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StepEnd {
    ToolCalls,
    Turn(TurnStatus),
}

impl Serialize for StepEnd {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::ToolCalls => s.serialize_str("tool_calls"),
            Self::Turn(t) => t.serialize(s),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum StepEvent {
    Turn {
        turn: TurnInfo,
        #[serde(skip_serializing_if = "Option::is_none")]
        user_item: Option<ThreadItem>,
    },
    TextDelta {
        item_id: String,
        delta: String,
    },
    Item {
        item: ThreadItem,
    },
    Usage {
        turn: TurnInfo,
        credit: AiCredit,
    },
    StepEnd {
        status: StepEnd,
    },
    Thread {
        thread: ThreadSummary,
    },
    Error {
        code: AiErrorCode,
        message: String,
    },
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Instructions {
    pub notebook_id: Option<String>,
    pub text: String,
}
