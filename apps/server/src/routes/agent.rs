//! AI V2 endpoints: config, threads, turns and instructions. Shapes in `crate::agent`.

use std::collections::HashSet;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use super::ApiJson;
use crate::agent::step::{self, Step};
use crate::agent::store::{self, ListFilter};
use crate::agent::{
    prompt, AiConfigRes, AiLimits, AiPreset, ContinueReq, CreateThreadReq, Environment,
    Instructions, ItemBody, StartTurnReq, StepEvent, StepReq, ThreadDetailRes, ThreadSummary,
    ToolResult, TurnInfo, TurnStatus, UpdateThreadReq, UserMessage,
};
use crate::auth::AuthUser;
use crate::config::AiPreset as PresetConfig;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::util::validate_id;

const MAX_TEXT_CHARS: usize = 32_000;
const MAX_CHIPS: usize = 20;
const MAX_CONTEXT_CHARS: usize = 400_000;
const MAX_ATTACHMENTS: usize = 8;
const MAX_OUTLINE_CHARS: usize = 200_000;
const MAX_RESULT_CHARS: usize = 400_000;
const MAX_IMAGE_B64: usize = 14 * 1024 * 1024;
const MAX_TITLE_CHARS: usize = 200;
const MAX_PIN_KEY_LEN: usize = 64;
const MAX_INSTRUCTIONS_CHARS: usize = 4000;

fn ensure_configured(st: &AppState) -> AppResult<()> {
    if st.ai.is_configured() {
        Ok(())
    } else {
        Err(AppError::AiNotConfigured)
    }
}

fn bad(msg: &str) -> AppError {
    AppError::BadRequest(msg.into())
}

fn validate_message(m: &UserMessage) -> AppResult<()> {
    if m.text.trim().is_empty() && m.attachments.is_empty() && m.context.is_empty() {
        return Err(bad("message is empty"));
    }
    if m.text.chars().count() > MAX_TEXT_CHARS {
        return Err(bad("message text is too long"));
    }
    if m.context.len() > MAX_CHIPS
        || m.context
            .iter()
            .map(|c| c.content.len() + c.label.len())
            .sum::<usize>()
            > MAX_CONTEXT_CHARS
    {
        return Err(bad("too much context"));
    }
    if m.attachments.len() > MAX_ATTACHMENTS {
        return Err(bad("too many attachments"));
    }
    for id in &m.attachments {
        validate_id("attachment id", id)?;
    }
    if m.command.as_ref().is_some_and(|c| c.len() > 64) {
        return Err(bad("invalid command"));
    }
    Ok(())
}

fn validate_env(e: &Environment) -> AppResult<()> {
    if e.outline.len() > MAX_OUTLINE_CHARS {
        return Err(bad("outline is too long"));
    }
    let long = |s: &Option<String>| s.as_ref().is_some_and(|s| s.len() > 512);
    if long(&e.notebook_id) || long(&e.notebook_title) || long(&e.page_id) {
        return Err(bad("invalid environment"));
    }
    Ok(())
}

fn validate_result(r: &ToolResult) -> AppResult<()> {
    if r.output.to_string().len() > MAX_RESULT_CHARS {
        return Err(bad("tool result is too large"));
    }
    if r.image.as_ref().is_some_and(|i| i.len() > MAX_IMAGE_B64) {
        return Err(bad("tool result image is too large"));
    }
    Ok(())
}

fn preset<'a>(st: &'a AppState, id: &str) -> AppResult<&'a PresetConfig> {
    st.config
        .preset(id)
        .ok_or_else(|| AppError::BadRequest(format!("unknown preset {id}")))
}

/// GET /ai/config
pub async fn config(State(st): State<AppState>, user: AuthUser) -> AppResult<Json<AiConfigRes>> {
    ensure_configured(&st)?;
    let cfg = &st.config;
    Ok(Json(AiConfigRes {
        presets: cfg
            .ai_presets
            .iter()
            .map(|p| AiPreset {
                id: p.id.clone(),
                label: p.label.clone(),
                hint: p.hint.clone(),
                vision: p.vision,
            })
            .collect(),
        default_preset_id: cfg.ai_default_preset.clone(),
        credit: store::credit(&st.db, cfg, &user.user_id).await?,
        limits: AiLimits {
            max_steps: cfg.ai_max_steps,
            max_tokens_per_turn: cfg.ai_max_turn_tokens,
        },
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    /// A notebook id, or `library`.
    pub notebook_id: String,
    pub search: Option<String>,
    pub settled: Option<u8>,
}

/// GET /ai/threads
pub async fn list_threads(
    State(st): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<ThreadSummary>>> {
    let notebook_id = match q.notebook_id.as_str() {
        "library" => None,
        id => {
            validate_id("notebookId", id)?;
            Some(id)
        }
    };
    let settled = match q.settled {
        None => None,
        Some(0) => Some(false),
        Some(1) => Some(true),
        Some(_) => return Err(bad("settled must be 0 or 1")),
    };
    if q.search.as_ref().is_some_and(|s| s.len() > 200) {
        return Err(bad("search is too long"));
    }
    let filter = ListFilter {
        notebook_id,
        search: q.search.as_deref(),
        settled,
    };
    Ok(Json(
        store::list_threads(&st.db, &user.user_id, filter).await?,
    ))
}

/// POST /ai/threads
pub async fn create_thread(
    State(st): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<CreateThreadReq>,
) -> AppResult<Json<ThreadSummary>> {
    if let Some(nb) = &req.notebook_id {
        validate_id("notebookId", nb)?;
    }
    Ok(Json(
        store::create_thread(&st.db, &user.user_id, req.notebook_id.as_deref()).await?,
    ))
}

/// GET /ai/threads/{id}
pub async fn thread_detail(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Json<ThreadDetailRes>> {
    Ok(Json(detail(&st, &user.user_id, &id).await?))
}

async fn detail(st: &AppState, user_id: &str, id: &str) -> AppResult<ThreadDetailRes> {
    Ok(ThreadDetailRes {
        thread: store::summary(&st.db, user_id, id).await?,
        turns: store::turns(&st.db, id).await?,
        items: store::items(&st.db, id).await?,
    })
}

/// PATCH /ai/threads/{id}
pub async fn update_thread(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(req): ApiJson<UpdateThreadReq>,
) -> AppResult<Json<ThreadSummary>> {
    let title = req.title.as_deref().map(str::trim);
    if title.is_some_and(|t| t.is_empty() || t.chars().count() > MAX_TITLE_CHARS) {
        return Err(bad("title must be 1-200 characters"));
    }
    let pin_key = req.pin_key.as_ref().map(|k| k.as_deref());
    if let Some(Some(k)) = pin_key {
        let ok =
            !k.is_empty() && k.len() <= MAX_PIN_KEY_LEN && k.bytes().all(|b| b.is_ascii_graphic());
        if !ok {
            return Err(bad("invalid pinKey"));
        }
    }
    Ok(Json(
        store::update_thread(&st.db, &user.user_id, &id, title, pin_key, req.settled).await?,
    ))
}

/// DELETE /ai/threads/{id}. Never reverts notebook edits.
pub async fn delete_thread(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    store::delete_thread(&st.db, &user.user_id, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /ai/threads/{id}/turns -> SSE
pub async fn start_turn(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(req): ApiJson<StartTurnReq>,
) -> AppResult<Response> {
    ensure_configured(&st)?;
    let thread = store::thread(&st.db, &user.user_id, &id).await?;
    validate_id("deviceId", &req.device_id)?;
    validate_message(&req.message)?;
    validate_env(&req.environment)?;
    let preset = preset(&st, &req.preset_id)?.clone();
    prompt::check_attachments(&st, &user.user_id, &req.message.attachments, &preset).await?;

    let turn = store::insert_turn(&st.db, &thread.id, &preset.id, &req.device_id)
        .await?
        .ok_or_else(|| AppError::Conflict("another turn of this thread is still open".into()))?;
    let user_item = store::insert_item(
        &st.db,
        &thread.id,
        &turn.id,
        None,
        ItemBody::User(req.message),
    )
    .await?;
    store::touch_thread(&st.db, &thread.id, true).await?;
    let step = Step {
        st,
        thread,
        turn_id: turn.id.clone(),
        preset,
        environment: req.environment,
        counted: true,
    };
    let first = vec![StepEvent::Turn {
        turn,
        user_item: Some(user_item),
    }];
    Ok(step::run(step, first).into_response())
}

/// An `awaiting_tools` turn the calling device may run.
struct Awaiting {
    turn: TurnInfo,
    thread: store::ThreadRow,
    preset: PresetConfig,
}

async fn awaiting(
    st: &AppState,
    user: &AuthUser,
    turn_id: &str,
    device_id: &str,
) -> AppResult<Awaiting> {
    let (turn, thread) = store::user_turn(&st.db, &user.user_id, turn_id).await?;
    if device_id != turn.device_id {
        return Err(AppError::NotTurnDevice);
    }
    if turn.status != TurnStatus::AwaitingTools {
        return Err(AppError::TurnNotAwaiting);
    }
    let preset = preset(st, &turn.preset_id)?.clone();
    Ok(Awaiting {
        turn,
        thread,
        preset,
    })
}

/// Persists the results (and the steer message) and runs the next step.
async fn next_step(
    st: AppState,
    Awaiting {
        turn,
        thread,
        preset,
    }: Awaiting,
    results: Vec<ToolResult>,
    steer: Option<UserMessage>,
    environment: Environment,
    counted: bool,
) -> AppResult<Response> {
    if !store::transition(
        &st.db,
        &turn.id,
        TurnStatus::AwaitingTools,
        TurnStatus::Running,
        None,
    )
    .await?
    {
        return Err(AppError::TurnNotAwaiting);
    }
    let mut first = Vec::new();
    for r in results {
        let item =
            store::insert_item(&st.db, &thread.id, &turn.id, None, ItemBody::ToolResult(r)).await?;
        first.push(StepEvent::Item { item });
    }
    let user_item = match steer {
        Some(m) => {
            Some(store::insert_item(&st.db, &thread.id, &turn.id, None, ItemBody::User(m)).await?)
        }
        None => None,
    };
    store::touch_thread(&st.db, &thread.id, false).await?;
    first.insert(
        0,
        StepEvent::Turn {
            turn: store::turn(&st.db, &turn.id).await?,
            user_item,
        },
    );
    let step = Step {
        st,
        thread,
        turn_id: turn.id,
        preset,
        environment,
        counted,
    };
    Ok(step::run(step, first).into_response())
}

/// POST /ai/turns/{id}/step -> SSE
pub async fn step(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(req): ApiJson<StepReq>,
) -> AppResult<Response> {
    ensure_configured(&st)?;
    let claim = awaiting(&st, &user, &id, &req.device_id).await?;
    validate_env(&req.environment)?;
    if let Some(m) = &req.steer {
        validate_message(m)?;
        prompt::check_attachments(&st, &user.user_id, &m.attachments, &claim.preset).await?;
    }

    // The results must answer exactly the pending calls; they are stored in call order.
    let pending = store::pending_calls(&st.db, &claim.turn.id).await?;
    let mut results = req.results;
    let ids: HashSet<&str> = results.iter().map(|r| r.tool_call_id.as_str()).collect();
    if ids.len() != results.len()
        || ids.len() != pending.len()
        || pending
            .iter()
            .any(|c| !ids.contains(c.tool_call_id.as_str()))
    {
        return Err(bad("results must answer each pending tool call once"));
    }
    for r in &results {
        validate_result(r)?;
    }
    results.sort_by_key(|r| {
        pending
            .iter()
            .position(|c| c.tool_call_id == r.tool_call_id)
    });
    let counted = req.steer.is_some() || pending.iter().any(|c| c.name != "ask_user");
    next_step(st, claim, results, req.steer, req.environment, counted).await
}

/// POST /ai/turns/{id}/continue -> SSE. Answers the lost calls with an error and runs the next step.
pub async fn continue_turn(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    ApiJson(req): ApiJson<ContinueReq>,
) -> AppResult<Response> {
    ensure_configured(&st)?;
    let claim = awaiting(&st, &user, &id, &req.device_id).await?;
    validate_env(&req.environment)?;
    let results = store::pending_calls(&st.db, &claim.turn.id)
        .await?
        .into_iter()
        .map(|c| ToolResult {
            tool_call_id: c.tool_call_id,
            output: json!("interrupted: the result of this call was lost. Re-read the notebook before you continue."),
            is_error: true,
            image: None,
            effects: Vec::new(),
        })
        .collect();
    next_step(st, claim, results, None, req.environment, true).await
}

/// POST /ai/turns/{id}/cancel
pub async fn cancel(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Json<TurnInfo>> {
    let (turn, _) = store::user_turn(&st.db, &user.user_id, &id).await?;
    match turn.status {
        TurnStatus::Running => store::request_cancel(&st.db, &turn.id).await?,
        TurnStatus::AwaitingTools => {
            store::transition(
                &st.db,
                &turn.id,
                TurnStatus::AwaitingTools,
                TurnStatus::Cancelled,
                None,
            )
            .await?;
        }
        _ => {}
    }
    Ok(Json(store::turn(&st.db, &turn.id).await?))
}

/// POST /ai/turns/{id}/revert
pub async fn revert(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Json<ThreadDetailRes>> {
    let (turn, thread) = store::user_turn(&st.db, &user.user_id, &id).await?;
    store::revert_from(&st.db, &turn).await?;
    store::touch_thread(&st.db, &thread.id, false).await?;
    Ok(Json(detail(&st, &user.user_id, &thread.id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionsQuery {
    pub notebook_id: Option<String>,
}

/// GET /ai/instructions
pub async fn get_instructions(
    State(st): State<AppState>,
    user: AuthUser,
    Query(q): Query<InstructionsQuery>,
) -> AppResult<Json<Instructions>> {
    if let Some(nb) = &q.notebook_id {
        validate_id("notebookId", nb)?;
    }
    let text = store::instructions(&st.db, &user.user_id, q.notebook_id.as_deref()).await?;
    Ok(Json(Instructions {
        notebook_id: q.notebook_id,
        text: text.unwrap_or_default(),
    }))
}

/// PUT /ai/instructions. Empty text deletes.
pub async fn put_instructions(
    State(st): State<AppState>,
    user: AuthUser,
    ApiJson(req): ApiJson<Instructions>,
) -> AppResult<Json<Instructions>> {
    if let Some(nb) = &req.notebook_id {
        validate_id("notebookId", nb)?;
    }
    let text = req.text.trim();
    if text.chars().count() > MAX_INSTRUCTIONS_CHARS {
        return Err(bad("instructions are limited to 4000 characters"));
    }
    store::set_instructions(&st.db, &user.user_id, req.notebook_id.as_deref(), text).await?;
    Ok(Json(Instructions {
        notebook_id: req.notebook_id,
        text: text.to_string(),
    }))
}
