//! Persistence for threads, turns, items, daily usage and instructions. Every thread lookup is
//! scoped by user.

use sqlx::{QueryBuilder, Sqlite, SqliteConnection, SqlitePool};

use super::{
    AiCredit, ItemBody, ThreadItem, ThreadStatus, ThreadSummary, ToolCall, TurnInfo, TurnStatus,
    NEW_THREAD_TITLE,
};
use crate::ai::Usage;
use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::util::{now_ms, utc_day};

const DAY_MS: i64 = 86_400_000;
/// Unpinned threads without activity for this long are settled when the list is read.
const AUTO_SETTLE_MS: i64 = 3 * DAY_MS;

#[derive(sqlx::FromRow, Clone, Debug)]
pub struct ThreadRow {
    pub id: String,
    pub user_id: String,
    pub notebook_id: Option<String>,
    pub title: String,
    pub title_locked: bool,
    pub pin_key: Option<String>,
    pub settled_at: Option<i64>,
    /// Suffix of the untrusted-data fence in prompts.
    pub fence: String,
    pub last_activity_at: i64,
    pub created_at: i64,
}

#[derive(sqlx::FromRow)]
struct ListedThread {
    #[sqlx(flatten)]
    thread: ThreadRow,
    turn_id: Option<String>,
    turn_status: Option<TurnStatus>,
}

/// Threads with the id and status of their latest non-reverted turn.
const THREAD_SELECT: &str = "SELECT t.*,
    (SELECT u.id FROM ai_turns u WHERE u.thread_id = t.id AND u.status != 'reverted' ORDER BY u.seq DESC LIMIT 1) AS turn_id,
    (SELECT u.status FROM ai_turns u WHERE u.thread_id = t.id AND u.status != 'reverted' ORDER BY u.seq DESC LIMIT 1) AS turn_status
    FROM ai_threads t WHERE t.user_id = ";

/// `SELECT <TurnInfo columns> FROM ai_turns <rest>`, as a literal (sqlx wants static SQL).
macro_rules! select_turns {
    ($rest:literal) => {
        concat!(
            "SELECT id, thread_id, seq, status, preset_id, device_id, steps, tokens_in, tokens_out, ",
            "cached_tokens, cost_usd, error, created_at, updated_at FROM ai_turns ",
            $rest
        )
    };
}

fn not_found() -> AppError {
    AppError::NotFound("thread not found".into())
}

pub async fn create_thread(
    db: &SqlitePool,
    user_id: &str,
    notebook_id: Option<&str>,
) -> AppResult<ThreadSummary> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    sqlx::query(
        "INSERT INTO ai_threads (id, user_id, notebook_id, title, fence, last_activity_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(notebook_id)
    .bind(NEW_THREAD_TITLE)
    .bind(&uuid::Uuid::new_v4().simple().to_string()[..12])
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    summary(db, user_id, &id).await
}

pub async fn thread(db: &SqlitePool, user_id: &str, id: &str) -> AppResult<ThreadRow> {
    sqlx::query_as("SELECT * FROM ai_threads WHERE user_id = ? AND id = ?")
        .bind(user_id)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(not_found)
}

pub async fn summary(db: &SqlitePool, user_id: &str, id: &str) -> AppResult<ThreadSummary> {
    let mut q = QueryBuilder::<Sqlite>::new(THREAD_SELECT);
    q.push_bind(user_id).push(" AND t.id = ").push_bind(id);
    let row: ListedThread = q
        .build_query_as()
        .fetch_optional(db)
        .await?
        .ok_or_else(not_found)?;
    to_summary(db, row).await
}

pub struct ListFilter<'a> {
    /// `None` lists library threads.
    pub notebook_id: Option<&'a str>,
    pub search: Option<&'a str>,
    pub settled: Option<bool>,
}

/// Pinned first (by key), then by last activity. Settles idle threads first.
pub async fn list_threads(
    db: &SqlitePool,
    user_id: &str,
    f: ListFilter<'_>,
) -> AppResult<Vec<ThreadSummary>> {
    let now = now_ms();
    sqlx::query(
        "UPDATE ai_threads SET settled_at = ? WHERE user_id = ? AND settled_at IS NULL
         AND pin_key IS NULL AND last_activity_at < ?
         AND NOT EXISTS (SELECT 1 FROM ai_turns u WHERE u.thread_id = ai_threads.id
                         AND u.status IN ('running', 'awaiting_tools'))",
    )
    .bind(now)
    .bind(user_id)
    .bind(now - AUTO_SETTLE_MS)
    .execute(db)
    .await?;

    let mut q = QueryBuilder::<Sqlite>::new(THREAD_SELECT);
    q.push_bind(user_id);
    match f.notebook_id {
        Some(nb) => q.push(" AND t.notebook_id = ").push_bind(nb),
        None => q.push(" AND t.notebook_id IS NULL"),
    };
    match f.settled {
        Some(true) => q.push(" AND t.settled_at IS NOT NULL"),
        Some(false) => q.push(" AND t.settled_at IS NULL"),
        None => &mut q,
    };
    if let Some(search) = f.search.map(str::trim).filter(|s| !s.is_empty()) {
        let pattern = format!(
            "%{}%",
            search
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        q.push(" AND (t.title LIKE ")
            .push_bind(pattern.clone())
            .push(
                " ESCAPE '\\' OR EXISTS (SELECT 1 FROM ai_items i WHERE i.thread_id = t.id
                  AND i.kind IN ('user', 'assistant') AND json_extract(i.payload, '$.text') LIKE ",
            )
            .push_bind(pattern)
            .push(" ESCAPE '\\'))");
    }
    q.push(" ORDER BY t.pin_key IS NULL, t.pin_key, t.last_activity_at DESC");
    let rows: Vec<ListedThread> = q.build_query_as().fetch_all(db).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(to_summary(db, row).await?);
    }
    Ok(out)
}

async fn to_summary(db: &SqlitePool, row: ListedThread) -> AppResult<ThreadSummary> {
    let status = match (row.turn_status, &row.turn_id) {
        (Some(TurnStatus::Running), _) => ThreadStatus::Running,
        (Some(TurnStatus::AwaitingTools), Some(turn_id)) => {
            let asks = pending_calls(db, turn_id)
                .await?
                .iter()
                .any(|c| c.name == "ask_user");
            if asks {
                ThreadStatus::NeedsInput
            } else {
                ThreadStatus::AwaitingTools
            }
        }
        (Some(TurnStatus::Failed), _) => ThreadStatus::Failed,
        _ => ThreadStatus::Idle,
    };
    let t = row.thread;
    Ok(ThreadSummary {
        id: t.id,
        notebook_id: t.notebook_id,
        title: t.title,
        pin_key: t.pin_key,
        settled_at: t.settled_at,
        last_activity_at: t.last_activity_at,
        created_at: t.created_at,
        status,
    })
}

/// Applies a validated PATCH. A new title locks it against auto titling.
pub async fn update_thread(
    db: &SqlitePool,
    user_id: &str,
    id: &str,
    title: Option<&str>,
    pin_key: Option<Option<&str>>,
    settled: Option<bool>,
) -> AppResult<ThreadSummary> {
    thread(db, user_id, id).await?;
    let mut tx = db.begin().await?;
    if let Some(title) = title {
        sqlx::query("UPDATE ai_threads SET title = ?, title_locked = 1 WHERE id = ?")
            .bind(title)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(pin_key) = pin_key {
        sqlx::query("UPDATE ai_threads SET pin_key = ? WHERE id = ?")
            .bind(pin_key)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(settled) = settled {
        sqlx::query("UPDATE ai_threads SET settled_at = CASE WHEN ? THEN COALESCE(settled_at, ?) END WHERE id = ?")
            .bind(settled)
            .bind(now_ms())
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    summary(db, user_id, id).await
}

/// Sets the auto title unless the user renamed the thread meanwhile.
pub async fn set_auto_title(
    db: &SqlitePool,
    user_id: &str,
    id: &str,
    title: &str,
) -> AppResult<Option<ThreadSummary>> {
    let res = sqlx::query("UPDATE ai_threads SET title = ? WHERE id = ? AND title_locked = 0")
        .bind(title)
        .bind(id)
        .execute(db)
        .await?;
    if res.rows_affected() == 0 {
        return Ok(None);
    }
    summary(db, user_id, id).await.map(Some)
}

pub async fn delete_thread(db: &SqlitePool, user_id: &str, id: &str) -> AppResult<()> {
    let res = sqlx::query("DELETE FROM ai_threads WHERE user_id = ? AND id = ?")
        .bind(user_id)
        .bind(id)
        .execute(db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(not_found());
    }
    Ok(())
}

/// Records activity. A new turn also unsettles the thread.
pub async fn touch_thread(db: &SqlitePool, id: &str, unsettle: bool) -> AppResult<()> {
    sqlx::query(
        "UPDATE ai_threads SET last_activity_at = ?,
         settled_at = CASE WHEN ? THEN NULL ELSE settled_at END WHERE id = ?",
    )
    .bind(now_ms())
    .bind(unsettle)
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn turns(db: &SqlitePool, thread_id: &str) -> AppResult<Vec<TurnInfo>> {
    Ok(
        sqlx::query_as(select_turns!("WHERE thread_id = ? ORDER BY seq"))
            .bind(thread_id)
            .fetch_all(db)
            .await?,
    )
}

pub async fn turn(db: &SqlitePool, id: &str) -> AppResult<TurnInfo> {
    Ok(sqlx::query_as(select_turns!("WHERE id = ?"))
        .bind(id)
        .fetch_one(db)
        .await?)
}

/// A turn and its thread, if the thread belongs to the user.
pub async fn user_turn(
    db: &SqlitePool,
    user_id: &str,
    turn_id: &str,
) -> AppResult<(TurnInfo, ThreadRow)> {
    let turn: TurnInfo = sqlx::query_as(select_turns!("WHERE id = ?"))
        .bind(turn_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("turn not found".into()))?;
    let thread = thread(db, user_id, &turn.thread_id)
        .await
        .map_err(|_| AppError::NotFound("turn not found".into()))?;
    Ok((turn, thread))
}

/// Starts a turn unless another one in the thread is still running or awaiting tools.
pub async fn insert_turn(
    db: &SqlitePool,
    thread_id: &str,
    preset_id: &str,
    device_id: &str,
) -> AppResult<Option<TurnInfo>> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let res = sqlx::query(
        "INSERT INTO ai_turns (id, thread_id, seq, status, preset_id, device_id, created_at, updated_at)
         SELECT ?, ?, COALESCE((SELECT MAX(seq) FROM ai_turns WHERE thread_id = ?), 0) + 1, 'running', ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM ai_turns WHERE thread_id = ? AND status IN ('running', 'awaiting_tools'))",
    )
    .bind(&id)
    .bind(thread_id)
    .bind(thread_id)
    .bind(preset_id)
    .bind(device_id)
    .bind(now)
    .bind(now)
    .bind(thread_id)
    .execute(db)
    .await?;
    if res.rows_affected() == 0 {
        return Ok(None);
    }
    turn(db, &id).await.map(Some)
}

/// Moves a turn from `from` to `to`. False when it was no longer in `from`.
pub async fn transition(
    db: &SqlitePool,
    id: &str,
    from: TurnStatus,
    to: TurnStatus,
    error: Option<&str>,
) -> AppResult<bool> {
    let res = sqlx::query(
        "UPDATE ai_turns SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ? AND status = ?",
    )
    .bind(to)
    .bind(error)
    .bind(now_ms())
    .bind(id)
    .bind(from)
    .execute(db)
    .await?;
    Ok(res.rows_affected() == 1)
}

pub async fn request_cancel(db: &SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("UPDATE ai_turns SET cancel_requested = 1 WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn cancel_requested(db: &SqlitePool, id: &str) -> AppResult<bool> {
    Ok(
        sqlx::query_scalar("SELECT cancel_requested FROM ai_turns WHERE id = ?")
            .bind(id)
            .fetch_one(db)
            .await?,
    )
}

/// Marks this turn and every later one in the thread `reverted`.
pub async fn revert_from(db: &SqlitePool, turn: &TurnInfo) -> AppResult<()> {
    let running: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM ai_turns WHERE thread_id = ? AND seq >= ? AND status = 'running')",
    )
    .bind(&turn.thread_id)
    .bind(turn.seq)
    .fetch_one(db)
    .await?;
    if running {
        return Err(AppError::Conflict(
            "cancel the running turn before reverting".into(),
        ));
    }
    sqlx::query(
        "UPDATE ai_turns SET status = 'reverted', updated_at = ? WHERE thread_id = ? AND seq >= ?",
    )
    .bind(now_ms())
    .bind(&turn.thread_id)
    .bind(turn.seq)
    .execute(db)
    .await?;
    Ok(())
}

/// Turns that were running when the process stopped can never finish.
pub async fn fail_interrupted(db: &SqlitePool) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE ai_turns SET status = 'failed', error = 'interrupted by a server restart', updated_at = ?
         WHERE status = 'running'",
    )
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}

/// Adds one model call to the turn and the user's daily usage.
pub async fn record_step(
    db: &SqlitePool,
    user_id: &str,
    turn_id: &str,
    usage: &Usage,
    cost: f64,
    counted: bool,
) -> AppResult<TurnInfo> {
    let mut tx = db.begin().await?;
    sqlx::query(
        "UPDATE ai_turns SET steps = steps + ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
         cached_tokens = cached_tokens + ?, cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?",
    )
    .bind(counted as i64)
    .bind(usage.prompt_tokens)
    .bind(usage.completion_tokens)
    .bind(usage.cached_tokens)
    .bind(cost)
    .bind(now_ms())
    .bind(turn_id)
    .execute(&mut *tx)
    .await?;
    add_usage(
        &mut tx,
        user_id,
        cost,
        usage.prompt_tokens + usage.completion_tokens,
    )
    .await?;
    tx.commit().await?;
    turn(db, turn_id).await
}

/// Charges a call outside the agent loop (handwriting recognition).
pub async fn record_usage(db: &SqlitePool, user_id: &str, cost: f64, tokens: i64) -> AppResult<()> {
    add_usage(&mut *db.acquire().await?, user_id, cost, tokens).await
}

async fn add_usage(
    conn: &mut SqliteConnection,
    user_id: &str,
    cost: f64,
    tokens: i64,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO ai_usage (user_id, day, cost_usd, tokens) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd,
         tokens = tokens + excluded.tokens",
    )
    .bind(user_id)
    .bind(utc_day(now_ms()))
    .bind(cost)
    .bind(tokens)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn credit(db: &SqlitePool, cfg: &Config, user_id: &str) -> AppResult<AiCredit> {
    let now = now_ms();
    let used: Option<f64> =
        sqlx::query_scalar("SELECT cost_usd FROM ai_usage WHERE user_id = ? AND day = ?")
            .bind(user_id)
            .bind(utc_day(now))
            .fetch_optional(db)
            .await?;
    Ok(AiCredit {
        limit_usd: cfg.ai_daily_credit_usd,
        used_usd: used.unwrap_or(0.0),
        resets_at: (now.div_euclid(DAY_MS) + 1) * DAY_MS,
    })
}

#[derive(sqlx::FromRow)]
struct ItemRow {
    id: String,
    thread_id: String,
    turn_id: String,
    seq: i64,
    kind: String,
    payload: String,
    created_at: i64,
}

impl TryFrom<ItemRow> for ThreadItem {
    type Error = AppError;
    fn try_from(r: ItemRow) -> AppResult<Self> {
        Ok(ThreadItem {
            body: ItemBody::from_db(&r.kind, &r.payload).map_err(AppError::internal)?,
            id: r.id,
            thread_id: r.thread_id,
            turn_id: r.turn_id,
            seq: r.seq,
            created_at: r.created_at,
        })
    }
}

/// Appends an item with the next seq of its thread. `id` lets streamed text keep its item id.
pub async fn insert_item(
    db: &SqlitePool,
    thread_id: &str,
    turn_id: &str,
    id: Option<String>,
    body: ItemBody,
) -> AppResult<ThreadItem> {
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = now_ms();
    let seq: i64 = sqlx::query_scalar(
        "INSERT INTO ai_items (id, thread_id, turn_id, seq, kind, payload, created_at)
         SELECT ?, ?, ?, COALESCE((SELECT MAX(seq) FROM ai_items WHERE thread_id = ?), 0) + 1, ?, ?, ?
         RETURNING seq",
    )
    .bind(&id)
    .bind(thread_id)
    .bind(turn_id)
    .bind(thread_id)
    .bind(body.kind())
    .bind(body.payload_json())
    .bind(now)
    .fetch_one(db)
    .await?;
    Ok(ThreadItem {
        id,
        thread_id: thread_id.into(),
        turn_id: turn_id.into(),
        seq,
        body,
        created_at: now,
    })
}

pub async fn items(db: &SqlitePool, thread_id: &str) -> AppResult<Vec<ThreadItem>> {
    let rows: Vec<ItemRow> =
        sqlx::query_as("SELECT * FROM ai_items WHERE thread_id = ? ORDER BY seq")
            .bind(thread_id)
            .fetch_all(db)
            .await?;
    rows.into_iter().map(ThreadItem::try_from).collect()
}

/// The transcript the model sees: items of non-reverted turns.
pub async fn history_items(db: &SqlitePool, thread_id: &str) -> AppResult<Vec<ThreadItem>> {
    let rows: Vec<ItemRow> = sqlx::query_as(
        "SELECT i.* FROM ai_items i JOIN ai_turns u ON u.id = i.turn_id
         WHERE i.thread_id = ? AND u.status != 'reverted' ORDER BY i.seq",
    )
    .bind(thread_id)
    .fetch_all(db)
    .await?;
    rows.into_iter().map(ThreadItem::try_from).collect()
}

/// Tool calls of a turn that have no result yet, in call order.
pub async fn pending_calls(db: &SqlitePool, turn_id: &str) -> AppResult<Vec<ToolCall>> {
    let rows: Vec<ItemRow> = sqlx::query_as(
        "SELECT * FROM ai_items WHERE turn_id = ? AND kind IN ('tool_call', 'tool_result') ORDER BY seq",
    )
    .bind(turn_id)
    .fetch_all(db)
    .await?;
    let mut calls = Vec::new();
    for row in rows {
        match ThreadItem::try_from(row)?.body {
            ItemBody::ToolCall(c) => calls.push(c),
            ItemBody::ToolResult(r) => calls.retain(|c| c.tool_call_id != r.tool_call_id),
            _ => {}
        }
    }
    Ok(calls)
}

pub async fn instructions(
    db: &SqlitePool,
    user_id: &str,
    notebook_id: Option<&str>,
) -> AppResult<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT text FROM ai_instructions WHERE user_id = ? AND notebook_id IS ?",
    )
    .bind(user_id)
    .bind(notebook_id)
    .fetch_optional(db)
    .await?)
}

/// Replaces the text; empty deletes it.
pub async fn set_instructions(
    db: &SqlitePool,
    user_id: &str,
    notebook_id: Option<&str>,
    text: &str,
) -> AppResult<()> {
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM ai_instructions WHERE user_id = ? AND notebook_id IS ?")
        .bind(user_id)
        .bind(notebook_id)
        .execute(&mut *tx)
        .await?;
    if !text.is_empty() {
        sqlx::query(
            "INSERT INTO ai_instructions (user_id, notebook_id, text, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(user_id)
        .bind(notebook_id)
        .bind(text)
        .bind(now_ms())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
