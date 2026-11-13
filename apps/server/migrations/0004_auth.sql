-- Own accounts: passkey sign-in, invite and reset links, recovery codes and browser sessions.

ALTER TABLE users ADD COLUMN name TEXT;
-- WebAuthn user handle (a UUID) that this user's passkeys carry. Set with the first passkey.
ALTER TABLE users ADD COLUMN passkey_handle TEXT;
CREATE UNIQUE INDEX users_passkey_handle ON users (passkey_handle);

-- `id` is the base64url credential id, `passkey` the webauthn-rs credential as JSON.
CREATE TABLE passkeys (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    passkey       TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
);
CREATE INDEX passkeys_user ON passkeys (user_id);

-- Single-use links to register a passkey: an invite for a new account (no user_id)
-- or an admin reset of an existing one.
CREATE TABLE enrollments (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);

CREATE TABLE recovery_codes (
    code_hash  TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL
);
CREATE INDEX recovery_codes_user ON recovery_codes (user_id);

-- token_hash is the hex SHA-256 of the cookie value, so a database leak yields no usable tokens.
CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
