# folio-server

Thin replication, asset and AI endpoint for folio (Rust, Axum 0.8, SQLx/SQLite, object_store).
CRDT (Loro) updates and snapshots are **opaque blobs**: the server orders, stores and serves them, nothing more.

## Run

```sh
cp .env.example .env      # edit; then export the vars or use your process manager
FOLIO_AUTH_DEV=true cargo run          # local dev, tokens: "Authorization: Bearer dev:<user-id>"
cargo test && cargo clippy --all-targets
```

## Configuration (environment)

| Variable                                                                                                          | Default                  | Notes                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `FOLIO_BIND`                                                                                                      | `0.0.0.0:8989`           |                                                                                                                                                |
| `FOLIO_WEB_DIR`                                                                                                   | unset                    | built web app to serve at `/` (with `/config.json`); unset = API only. The image sets `/app/web`                                               |
| `DATABASE_URL`                                                                                                    | `sqlite://data/folio.db` | created (with parent dirs) on start; migrations run automatically                                                                              |
| `FOLIO_CORS_ORIGINS`                                                                                              | empty                    | comma list or `*`; empty disables CORS headers                                                                                                 |
| `FOLIO_PUBLIC_URL`                                                                                                | unset                    | URL people open folio on, e.g. `https://folio.example.com`. No path. Enables accounts; passkeys are bound to its host, and cookie-authenticated writes must come from it. Unset = no accounts |
| `FOLIO_SESSION_DAYS`                                                                                              | `90`                     | a session ends after this many days without use (1 to 400)                                                                                     |
| `FOLIO_AUTH_DEV`                                                                                                  | `false`                  | accepts `Bearer dev:<user-id>`; logs a warning. Never in production                                                                            |
| `FOLIO_S3_BUCKET`, `FOLIO_S3_ENDPOINT`, `FOLIO_S3_REGION`, `FOLIO_S3_ACCESS_KEY_ID`, `FOLIO_S3_SECRET_ACCESS_KEY` | unset                    | any S3-compatible store (AWS, R2, B2, MinIO). Without a bucket, files go to `FOLIO_ASSETS_DIR` (`data/assets`). `AWS_*` key vars are also read |
| `OPENROUTER_API_KEY`                                                                                              | unset                    | all AI goes through OpenRouter. Unset => `/api/ai/*` answers `503 AI not configured`                                                               |
| `FOLIO_AI_PRESETS`                                                                                                | Fast, Smart, Deep        | JSON array of `{id, label, hint, model, vision, inputPrice, outputPrice, cachedInputPrice}` (OpenRouter slug, USD per million tokens; prices only estimate a stopped step). Defaults: Haiku 5.5, Sonnet 5.5, Opus 5.5 |
| `FOLIO_AI_DEFAULT_PRESET`                                                                                         | `smart`                  | preset for new turns; `/ai/recognize` also uses its model                                                                                      |
| `FOLIO_AI_TITLE_MODEL`                                                                                            | `anthropic/claude-haiku-5.5` | writes thread titles; not charged to the user                                                                                              |
| `FOLIO_AI_DAILY_CREDIT_USD`                                                                                       | `1.0`                    | AI spend per user per UTC day as OpenRouter reports it (`usage.cost`), then `credit_exhausted`. A step stopped before that report is estimated from its tokens at the preset prices. Failed calls cost nothing |
| `FOLIO_AI_MAX_STEPS`, `FOLIO_AI_MAX_TURN_TOKENS`                                                                  | `25`, `2000000`          | per-turn caps; hitting one ends the turn `partial`. Answers to `ask_user` don't count as a step                                               |
| `FOLIO_MAX_UPDATE_BYTES`                                                                                          | 8 MiB                    | per sync update / `FOLIO_MAX_ASSET_BYTES` (25 MiB) per asset and snapshot                                                                      |
| `FOLIO_PUSH_RATE_PER_MIN`                                                                                         | `600`                    | per-user sync pushes per minute                                                                                                                |
| `FOLIO_LOG`, `FOLIO_LOG_FORMAT`                                                                                   | `info`, json             | `RUST_LOG` syntax; `pretty` for human output                                                                                                   |

## API

All routes live under `/api` (`/health` is also served at the root for probes). All except `/health` and the sign-in routes under `/auth` need a session: the `folio_session` cookie set by sign-in (`__Host-folio_session` on HTTPS), or `Authorization: Bearer dev:<user-id>` with `FOLIO_AUTH_DEV`. Cookie-authenticated writes and the sign-in calls must carry `Origin: <FOLIO_PUBLIC_URL>`, which browsers send on their own. Errors are `{ "error": code, "message": text }`.
Binary values are base64 (standard alphabet) strings. Ids (`docId`, `deviceId`, asset id) match `[A-Za-z0-9_.:-]{1,128}`.

- `GET /health` -> `{status:"ok", version}`
- Passkeys: each ceremony is a `start` that returns `{ceremony, options}` (WebAuthn options, binary fields base64url) and a `finish` that takes `{ceremony, credential}` within 5 minutes.
  - `POST /auth/passkey/register/start` `{token, name?}` for an invite (`name` required) or reset link, or `{}` for a signed-in person adding a passkey. `POST /auth/passkey/register/finish` -> `{user, recoveryCodes?}`. A link registration signs in and returns 10 new recovery codes.
  - `POST /auth/passkey/login/start`, `POST /auth/passkey/login/finish` -> `{user}` and the session cookie.
- `POST /auth/recover` `{code}` -> `{user}` and the session cookie. Uses the code up.
- `GET /auth/account` -> `{passkeys: [{id, createdAt, lastUsedAt}], recoveryCodesLeft}`, `DELETE /auth/passkeys/{id}` (409 for the last one), `POST /auth/recovery-codes` -> `{recoveryCodes}` replaces them.
- `GET /auth/session` -> `{available, user: {id, name} | null}`. `available` says whether accounts are set up. Renews the cookie.
- `POST /auth/logout` ends this browser's session.
- `POST /sync/push` `{docId, deviceId, update}` -> `{seq}` (413 over size limit, 429 rate limited). `seq` is strictly increasing per document.
- `GET /sync/pull?docId=&since=<seq>&limit=` -> `{updates:[{seq, update}], latestSeq, hasMore, snapshot?:{uptoSeq, data}}`.
  If a snapshot newer than `since` exists it is returned and `updates` are those after it. When `hasMore`, pull again with `since` = last returned seq (or `snapshot.uptoSeq` if no updates were returned).
- `POST /sync/compact` `{docId, uptoSeq, snapshot}` -> `{uptoSeq, deletedUpdates}`. The client provides a merged snapshot covering all updates `<= uptoSeq`; the server stores it in the object store and deletes those updates. 409 if a newer snapshot exists.
- `GET /sync/changes?since=<cursor>` -> `{cursor, docs:[{docId, latestSeq, updatedAt}]}`. Authenticated long poll, up to 20 seconds. Returns committed changes for this account immediately; pass the returned cursor on the next request. Durable sequences recover missed updates after reconnecting.
- `GET /sync/docs` -> `[{docId, latestSeq, updatedAt}]` (ms epoch)
- `POST /devices` `{deviceId, name}` register / heartbeat
- `POST /assets?id=<optional client id>` raw body + `Content-Type` -> `{id}`; `GET /assets/{id}` -> bytes (owner only; served `nosniff` + CSP sandbox)
- `POST /ai/recognize` `{image: base64 png, languages?: ["de","en"], hint?}` -> `{text, confidence}`
- AI agent (shapes in `apps/web/src/ai/protocol.ts`, `/turns`, `/step` and `/continue` answer `text/event-stream`):
  - `GET /ai/config` -> presets, default preset, credit and caps
  - `GET /ai/threads?notebookId=<id>|library&search=&settled=0|1`, `POST /ai/threads` `{notebookId}`, `GET|PATCH|DELETE /ai/threads/{id}`
  - `POST /ai/threads/{id}/turns` `{message, presetId, deviceId, environment}` starts a turn and streams its first model step
  - `POST /ai/turns/{id}/step` `{deviceId, results, environment, steer?}` posts the tool results and streams the next step (only the turn's device)
  - `POST /ai/turns/{id}/results` `{deviceId, results}` -> 204, stores results for pending calls without a step (a turn stopped while its tools ran)
  - `POST /ai/turns/{id}/continue` `{deviceId, environment}` answers lost tool calls with an error and streams the next step
  - `POST /ai/turns/{id}/cancel` -> the turn once it settled (waits up to 3 s for a streaming step to stop), `POST /ai/turns/{id}/revert` -> thread detail
  - `GET /ai/instructions?notebookId=`, `PUT /ai/instructions` `{notebookId, text}` (max 4000 characters, empty deletes)
- Removed with AI V2: `POST /ai/summarize` and `POST /ai/ask`. Summaries and questions are ordinary turns now. `FOLIO_AI_MODEL`, `FOLIO_AI_VISION_MODEL` and `FOLIO_AI_DAILY_QUOTA` are no longer read: use `FOLIO_AI_PRESETS`, `FOLIO_AI_DEFAULT_PRESET` and `FOLIO_AI_DAILY_CREDIT_USD`.

## Deploy notes

- Docker: the root `Dockerfile` builds web app + server into one image (`docker build -t folio .`, published as `ghcr.io/badmike/folio`). Run it with `docker run -p 8989:8989 -v folio-data:/app/data --env-file .env folio`. It runs as a non-root user and exposes a `--healthcheck` probe.
- SQLite (WAL) is a single-node store: run one replica and back up the `data/` volume (or use Litestream). Snapshots and assets live in the object store, so use S3 for durability.
- Terminate TLS in front (Caddy, nginx, a platform router). Set `FOLIO_PUBLIC_URL` for accounts; keep `FOLIO_AUTH_DEV` off. Sign-in needs the web app on the server's own origin: the session cookie is not sent from other origins, so `FOLIO_CORS_ORIGINS` only serves dev tokens.
- Logs are JSON on stdout. Failures carry a `counter` field (`auth_failure`, `sync_failure`, `storage_error`, `ai_failure`, `db_error`, `internal_error`) for log-based metrics; every request carries an `x-request-id`.
- SIGTERM/SIGINT triggers graceful shutdown.

## Accounts and sessions

- Accounts are invite-only and sign in with a passkey. The server stores no passwords: a passkey row holds the public key (`passkeys`), and a user's `passkey_handle` is the WebAuthn user handle its passkeys carry.
- Admin commands run against the configured database and print to stdout (`docker exec <container> folio-server <command>`):
  - `folio-server invite` prints a link that creates one account, valid 7 days.
  - `folio-server reset <user-id>` prints a link, valid 1 day, that replaces the account's passkeys and recovery codes and signs it out everywhere.
  - `folio-server users` lists accounts with their passkey count.
- Links put the token in the URL fragment (`/#invite=...`, `/#reset=...`), so it never reaches access logs. The database keeps only token hashes (`enrollments`).
- Each account has 10 single-use recovery codes (`recovery_codes`, hashed). One signs in once.
- A session is a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie. The database holds only its SHA-256 (`sessions`). It lasts `FOLIO_SESSION_DAYS` from its last use. Deleting a row signs that browser out, `DELETE FROM sessions WHERE user_id = ?` signs a person out everywhere.
- Passkeys are bound to the host of `FOLIO_PUBLIC_URL`. A new domain needs a reset link for every account.
- Moving from the Clerk-based releases: data is keyed by the old Clerk user id (`user_...`), and that row is in `users`. Run `folio-server reset user_...` and open the link to give the account its first passkey.
