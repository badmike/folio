-- Own accounts: profile fields from the sign-in provider, provider identities and browser sessions.

ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN name TEXT;
ALTER TABLE users ADD COLUMN picture TEXT;

-- One row per provider account. `subject` is the provider's stable id for the person.
CREATE TABLE identities (
    issuer      TEXT NOT NULL,
    subject     TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (issuer, subject)
);

-- token_hash is the hex SHA-256 of the cookie value, so a database leak yields no usable tokens.
CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
