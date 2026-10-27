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
| `FOLIO_CLERK_PUBLISHABLE_KEY`                                                                                     | unset                    | handed to the web app through `/config.json`                                                                                                   |
| `DATABASE_URL`                                                                                                    | `sqlite://data/folio.db` | created (with parent dirs) on start; migrations run automatically                                                                              |
| `FOLIO_CORS_ORIGINS`                                                                                              | empty                    | comma list or `*`; empty disables CORS headers                                                                                                 |
| `CLERK_ISSUER` / `CLERK_JWKS_URL`                                                                                 | none                     | JWKS URL defaults to `<issuer>/.well-known/jwks.json`; issuer is validated when set                                                            |
| `FOLIO_CLERK_AUTHORIZED_PARTIES`                                                                                  | empty                    | optional `azp` allow-list                                                                                                                      |
| `FOLIO_AUTH_DEV`                                                                                                  | `false`                  | accepts `Bearer dev:<user-id>`; logs a warning. Never in production                                                                            |
| `FOLIO_S3_BUCKET`, `FOLIO_S3_ENDPOINT`, `FOLIO_S3_REGION`, `FOLIO_S3_ACCESS_KEY_ID`, `FOLIO_S3_SECRET_ACCESS_KEY` | unset                    | any S3-compatible store (AWS, R2, B2, MinIO). Without a bucket, files go to `FOLIO_ASSETS_DIR` (`data/assets`). `AWS_*` key vars are also read |
| `OPENROUTER_API_KEY`                                                                                              | unset                    | all AI goes through OpenRouter. Unset => `/api/ai/*` answers `503 AI not configured`                                                               |
| `FOLIO_AI_PRESETS`                                                                                                | Fast, Smart, Deep        | JSON array of `{id, label, hint, model, vision, inputPrice, outputPrice, cachedInputPrice}` (OpenRouter slug, USD per million tokens). Defaults: Haiku 5.5, Sonnet 5.5, Opus 5.5 |
| `FOLIO_AI_DEFAULT_PRESET`                                                                                         | `smart`                  | preset for new turns; `/ai/recognize` also uses its model                                                                                      |
| `FOLIO_AI_TITLE_MODEL`                                                                                            | `anthropic/claude-haiku-5.5` | writes thread titles; not charged to the user                                                                                              |
| `FOLIO_AI_DAILY_CREDIT_USD`                                                                                       | `1.0`                    | AI spend per user per UTC day (tokens x preset price, cache reads included), then `credit_exhausted`. Failed calls cost nothing             |
| `FOLIO_AI_MAX_STEPS`, `FOLIO_AI_MAX_TURN_TOKENS`                                                                  | `25`, `2000000`          | per-turn caps; hitting one ends the turn `partial`. Answers to `ask_user` don't count as a step                                               |
| `FOLIO_MAX_UPDATE_BYTES`                                                                                          | 8 MiB                    | per sync update / `FOLIO_MAX_ASSET_BYTES` (25 MiB) per asset and snapshot                                                                      |
| `FOLIO_PUSH_RATE_PER_MIN`                                                                                         | `600`                    | per-user sync pushes per minute                                                                                                                |
| `FOLIO_LOG`, `FOLIO_LOG_FORMAT`                                                                                   | `info`, json             | `RUST_LOG` syntax; `pretty` for human output                                                                                                   |

## API

All routes live under `/api` (`/health` is also served at the root for probes). All except `/health` need `Authorization: Bearer <Clerk session JWT>`. Errors are `{ "error": code, "message": text }`.
Binary values are base64 (standard alphabet) strings. Ids (`docId`, `deviceId`, asset id) match `[A-Za-z0-9_.:-]{1,128}`.

- `GET /health` -> `{status:"ok", version}`
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
  - `POST /ai/turns/{id}/continue` `{deviceId, environment}` answers lost tool calls with an error and streams the next step
  - `POST /ai/turns/{id}/cancel` -> turn, `POST /ai/turns/{id}/revert` -> thread detail
  - `GET /ai/instructions?notebookId=`, `PUT /ai/instructions` `{notebookId, text}` (max 4000 characters, empty deletes)

## Deploy notes

- Docker: the root `Dockerfile` builds web app + server into one image (`docker build -t folio .`, published as `ghcr.io/badmike/folio`). Run it with `docker run -p 8989:8989 -v folio-data:/app/data --env-file .env folio`. It runs as a non-root user and exposes a `--healthcheck` probe.
- SQLite (WAL) is a single-node store: run one replica and back up the `data/` volume (or use Litestream). Snapshots and assets live in the object store, so use S3 for durability.
- Terminate TLS in front (Caddy, nginx, a platform router). Set `CLERK_ISSUER`; `FOLIO_CORS_ORIGINS` is only needed when the web app is hosted on another origin; keep `FOLIO_AUTH_DEV` off.
- Logs are JSON on stdout. Failures carry a `counter` field (`auth_failure`, `sync_failure`, `storage_error`, `ai_failure`, `db_error`, `internal_error`) for log-based metrics; every request carries an `x-request-id`.
- SIGTERM/SIGINT triggers graceful shutdown.
