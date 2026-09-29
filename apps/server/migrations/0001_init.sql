-- folio-server initial schema. The server is CRDT-agnostic: update payloads are opaque blobs.

CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL
);

CREATE TABLE devices (
    id          TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    last_seen   INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
);

CREATE TABLE docs (
    user_id     TEXT NOT NULL,
    doc_id      TEXT NOT NULL,
    latest_seq  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, doc_id)
);

-- seq is globally monotonic (AUTOINCREMENT) and therefore monotonic per document.
CREATE TABLE doc_updates (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    doc_id      TEXT NOT NULL,
    device_id   TEXT NOT NULL,
    bytes       BLOB NOT NULL,
    size        INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX idx_doc_updates_doc ON doc_updates (user_id, doc_id, seq);

CREATE TABLE doc_snapshots (
    user_id     TEXT NOT NULL,
    doc_id      TEXT NOT NULL,
    upto_seq    INTEGER NOT NULL,
    object_key  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, doc_id, upto_seq)
);

CREATE TABLE assets (
    id          TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    object_key  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
);

CREATE TABLE ai_jobs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    kind        TEXT NOT NULL,
    status      TEXT NOT NULL,
    tokens_in   INTEGER NOT NULL DEFAULT 0,
    tokens_out  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);
CREATE INDEX idx_ai_jobs_user ON ai_jobs (user_id, created_at);

CREATE TABLE quotas (
    user_id      TEXT NOT NULL,
    day          TEXT NOT NULL,
    ai_requests  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);
