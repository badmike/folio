# folio

Offline-first, semantic infinite-canvas notebook for iPad + Apple Pencil — by **Coder's Cantina**.

See [`docs/requirements.md`](docs/requirements.md) and [`docs/architecture.md`](docs/architecture.md).

## Monorepo

| Path                   | Purpose                                                                           |
| ---------------------- | --------------------------------------------------------------------------------- |
| `apps/web`             | Vue 3 + Vite PWA shell (library, toolbar, dialogs, settings)                      |
| `apps/server`          | Rust (Axum/Tokio/SQLx) sync, assets & AI gateway                                  |
| `packages/document`    | Semantic document model, Loro CRDT, operations, Markdown & `.folio` format        |
| `packages/editor`      | Framework-independent editor core (camera, tools, selection, undo, spatial index) |
| `packages/renderer`    | WebGL retained renderer, Canvas2D live ink + fallback, rough styling              |
| `packages/recognition` | Stroke grouping, shape & handwriting recognition (Web Worker)                     |
| `packages/persistence` | SQLite-WASM + OPFS storage, operation journal, FTS search                         |
| `packages/sync`        | Client-side CRDT replication                                                      |

## Development

```sh
pnpm install
pnpm dev          # web app on http://localhost:5173
pnpm test         # all TypeScript unit tests
pnpm typecheck
pnpm server       # Rust API on http://localhost:8989/api
```

## Using folio

`apps/web` is the installable PWA (Vue 3 + Vite). Everything works offline and without an account; data lives in SQLite (OPFS) on the device.

```sh
pnpm install
pnpm --filter @folio/web dev          # dev server (proxies /api -> http://localhost:8989)
pnpm --filter @folio/web build        # vue-tsc + vite build (service worker precaches app + OCR assets)
pnpm --filter @folio/web preview      # http://localhost:4173
pnpm --filter @folio/web test         # unit + component tests
pnpm --filter @folio/web exec playwright test   # e2e against the preview build (needs `build` first)
```

**Features:** infinite/A4/Letter/iPad pages with blank/ruled/grid/dot backgrounds (toggle with `⌘'`); pen, highlighter (flat, round, slanted or curvy edges), eraser, shapes (sharp or round corners), lines with extra points, straight/curved/elbow arrows, text, frames (content moves and clips with the frame, can be removed while keeping the content) and blur masks (pixelate or Gaussian) for reveal effects; hand tool and flick panning with inertia; tool lock (`Q`); align and distribute; per-notebook quick colour swatches (hold a swatch to change it), each drawing tool remembers its own colours, a stylus eraser end or barrel button erases; a compact quick bar for switching colours while writing; hand-drawn (Excalifont), normal and code (Fira Code) fonts, plus more bundled fonts in a popover (Caveat, Kalam, Patrick Hand, Indie Flower, Architects Daughter, Shadows Into Light, Gloria Hallelujah, Permanent Marker, Playpen Sans); selection with Clean Up (handwriting -> text, rough shapes -> shapes, non-destructive, "Restore ink"); automatic cleanup modes (keep / ask / auto); temporary read-only lock per notebook (`Alt+R`); zen mode (`Alt+Z`); folders, tags, search across typed text, handwriting and labels; export Markdown, PNG, PDF and `.folio`; import `.folio` and `.excalidraw` files, paste Excalidraw content straight onto a page; optional sync and an AI assistant (see below) when signed in to a folio server.

**Keyboard shortcuts** follow Excalidraw (press `?` in a notebook for the full list): `V` select, `H` hand, `R` rectangle, `D` diamond, `O` ellipse, `A` arrow, `L` line, `P` pen, `T` text, `E` eraser, `F` frame, `M` highlighter, `X` blur, `Q` tool lock, `⌘Z`/`⌘⇧Z` undo/redo, `⌘D` or `Alt`+drag duplicate, `⌘G` group, `⌘[`/`⌘]` layer order, `⌘⇧arrows` align, `⌘+`/`⌘-`/`⌘0` zoom, `Shift+1` fit.

**Runtime config:** at boot the app reads `config.json` next to `index.html` (`{"apiBase": "/api", "clerkPublishableKey": "pk_..."}`). folio-server generates it when it serves the app; empty values mean local only. During development, `apps/web/.env.local` provides the same values as `VITE_API_BASE` and `VITE_CLERK_PUBLISHABLE_KEY`.

**Icons and share card:** `node apps/web/scripts/gen-brand-assets.mjs` renders the favicon, app icons and the 1200x630 Open Graph image from `public/icons/icon.svg`. The share card URL is absolute: set `VITE_SITE_URL` (default `https://folio.coderscantina.com`) when building for another domain.

**With a server:** `FOLIO_AUTH_DEV=true pnpm server` (port 8989), start the web app with `VITE_API_BASE=/api`, then in the browser console run `localStorage['folio.devToken']='dev:alice'` and reload to sync without Clerk. Set `OPENROUTER_API_KEY` on the server for the AI assistant (all AI requests go through OpenRouter). `localStorage['folio.debug']='1'` exposes `window.__folio` (used by the e2e tests).

### Live sync across devices

Sign in to the same folio account on both devices and open the same notebook. Completed strokes and other edits sync automatically while you write, with local updates batched every 150 ms. Devices receive server notifications immediately and catch up after reconnecting. Writing and autosave still work offline.

For presenting, lock the notebook on the display device (`Alt+R`, or the notebook menu) and write on the iPad. The lock is local to that device and incoming edits still appear. Each device keeps its own camera and page selection. Unfinished strokes appear on the other device when you lift the Pencil.

### AI assistant

Open the AI dock with `⌘J` or the sparkle button. It keeps threads per notebook and streams its answers. It reads the open page and can draw, write and change the notebook through tools: shapes, text, arrows, diagrams with automatic layout, frames, images, pages and the notebook's title, tags and theme. It looks at drawings only when it needs to, and you can attach images.

- Edits apply live and glow briefly. Each turn is one undo step, and "Revert to this message" undoes the AI's edits from there on, skipping objects you changed since.
- Deleting a page and writing to another notebook ask for approval first. The AI can also ask you a question with a few options.
- A message sent while the AI works steers the running turn. Stop ends it and keeps the edits so far.
- If the tab closes mid-turn, the same device offers Continue.
- Threads get an automatic title and can be pinned, settled, searched and deleted. Deleting a thread never reverts edits.
- `/summarize`, `/lecture`, `/outline`, `/flashcards` and `/questions` are slash commands and starter chips.
- The composer picks a preset (Fast, Smart, Deep) and shows the credit left for the day.

The server owns the prompts, tool schemas, API key, budget and history. The browser runs every tool, because only it holds the notebook. Presets, the daily credit and the per-turn caps are server settings, listed in [`apps/server/README.md`](apps/server/README.md).

## Self-hosting

Each release publishes one image with the web app and the server: `ghcr.io/badmike/folio`. The server serves the app at `/`, the API under `/api` and `/health` for probes.

```sh
docker run -d -p 8989:8989 -v folio-data:/app/data ghcr.io/badmike/folio:latest
```

Or use [`docker-compose.yml`](docker-compose.yml) with a `.env` file next to it. Without any variables folio runs local-only: the app works, sync and AI stay off. Put TLS in front of the container, the PWA needs HTTPS outside `localhost`.

| Variable                                     | Purpose                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `CLERK_ISSUER`                               | Clerk instance URL; enables sign-in and sync (tokens are verified via JWKS) |
| `FOLIO_CLERK_PUBLISHABLE_KEY`                | Clerk publishable key, handed to the app through `/config.json`             |
| `OPENROUTER_API_KEY`                         | enables the AI assistant; presets, credit and caps have their own variables |
| `FOLIO_S3_BUCKET` and the other `FOLIO_S3_*` | S3-compatible storage for snapshots and assets instead of the data volume   |

All server settings are listed in [`apps/server/README.md`](apps/server/README.md). Data lives in the `/app/data` volume (SQLite plus local assets): back it up, run a single replica.

**Upgrading:** pin a version (`ghcr.io/badmike/folio:26.10.1-8e5921d`, or `FOLIO_VERSION=` for compose), pull the new one and restart. Migrations run on start.

**Static hosting:** every release also attaches `folio-web-<version>.tar.gz`. Unpack it on any static host with an `index.html` fallback for unknown paths, and point `config.json` at a folio server (`"apiBase": "https://folio.example.com/api"`, plus `FOLIO_CORS_ORIGINS` on that server).

## Releasing

Versions are calendar based: `vYY.M.D-<short hash>`, e.g. `v26.10.1-8e5921d`. On an up-to-date `main`, run:

```sh
./release.sh              # prepends the release to CHANGELOG.md, commits "🔖 Release <tag>", tags and pushes
./release.sh --backfill   # rebuilds CHANGELOG.md from all tags
```

The tag starts [`.github/workflows/release.yml`](.github/workflows/release.yml): the full CI suite, native amd64 and arm64 image builds, the multi-arch image on GHCR (`latest` only moves for the newest tag), provenance and SBOM attestations, and a GitHub release with the changelog block, `docker-compose.yml` and the web tarball. Set `FOLIO_VERSION` when building the image yourself: `docker build --build-arg FOLIO_VERSION=dev -t folio .`
