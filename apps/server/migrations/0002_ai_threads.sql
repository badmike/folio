-- AI V2: chat threads with turns and transcript items, daily credit in USD, custom instructions.
-- V1 request counting is replaced by ai_usage.

DROP TABLE ai_jobs;
DROP TABLE quotas;

-- notebook_id is null for library threads. fence is the random suffix of the untrusted-data fence,
-- fixed per thread so replayed history stays byte-identical (prompt cache).
CREATE TABLE ai_threads (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    notebook_id       TEXT,
    title             TEXT NOT NULL,
    title_locked      INTEGER NOT NULL DEFAULT 0,
    pin_key           TEXT,
    settled_at        INTEGER,
    fence             TEXT NOT NULL,
    last_activity_at  INTEGER NOT NULL,
    created_at        INTEGER NOT NULL
);
CREATE INDEX idx_ai_threads_user ON ai_threads (user_id, notebook_id, last_activity_at);

CREATE TABLE ai_turns (
    id                TEXT PRIMARY KEY,
    thread_id         TEXT NOT NULL REFERENCES ai_threads (id) ON DELETE CASCADE,
    seq               INTEGER NOT NULL,
    status            TEXT NOT NULL,
    preset_id         TEXT NOT NULL,
    device_id         TEXT NOT NULL,
    steps             INTEGER NOT NULL DEFAULT 0,
    tokens_in         INTEGER NOT NULL DEFAULT 0,
    tokens_out        INTEGER NOT NULL DEFAULT 0,
    cached_tokens     INTEGER NOT NULL DEFAULT 0,
    cost_usd          REAL NOT NULL DEFAULT 0,
    error             TEXT,
    cancel_requested  INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    UNIQUE (thread_id, seq)
);

-- payload is the item's JSON exactly as sent to the client.
CREATE TABLE ai_items (
    id          TEXT PRIMARY KEY,
    thread_id   TEXT NOT NULL REFERENCES ai_threads (id) ON DELETE CASCADE,
    turn_id     TEXT NOT NULL REFERENCES ai_turns (id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (thread_id, seq)
);
CREATE INDEX idx_ai_items_turn ON ai_items (turn_id, seq);

CREATE TABLE ai_usage (
    user_id   TEXT NOT NULL,
    day       TEXT NOT NULL,
    cost_usd  REAL NOT NULL DEFAULT 0,
    tokens    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);

-- notebook_id null holds the user-level text.
CREATE TABLE ai_instructions (
    user_id      TEXT NOT NULL,
    notebook_id  TEXT,
    text         TEXT NOT NULL,
    updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_ai_instructions ON ai_instructions (user_id, IFNULL(notebook_id, ''));
