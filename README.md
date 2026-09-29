# folio

Offline-first, semantic infinite-canvas notebook for iPad + Apple Pencil — by **Coder's Cantina**
(`com.coderscantina.folio`).

> Ink is the input method. Structured, machine-readable knowledge is the underlying product.

See [`docs/requirements.md`](docs/requirements.md) and [`docs/architecture.md`](docs/architecture.md).

## Monorepo

| Path | Purpose |
|---|---|
| `apps/web` | Vue 3 + Vite PWA shell (library, toolbar, dialogs, settings) |
| `apps/server` | Rust (Axum/Tokio/SQLx) sync, assets & AI gateway |
| `packages/document` | Semantic document model, Loro CRDT, operations, Markdown & `.folio` format |
| `packages/editor` | Framework-independent editor core (camera, tools, selection, undo, spatial index) |
| `packages/renderer` | WebGL retained renderer, Canvas2D live ink + fallback, rough styling |
| `packages/recognition` | Stroke grouping, shape & handwriting recognition (Web Worker) |
| `packages/persistence` | SQLite-WASM + OPFS storage, operation journal, FTS search |
| `packages/sync` | Client-side CRDT replication |

## Development

```sh
pnpm install
pnpm dev          # web app on http://localhost:5173
pnpm test         # all TypeScript unit tests
pnpm typecheck
pnpm server       # Rust API on http://localhost:8787
```

## Using folio

`apps/web` is the installable PWA (Vue 3 + Vite). Everything works offline and without an account; data lives in SQLite (OPFS) on the device.

```sh
pnpm install
pnpm --filter @folio/web dev          # dev server (proxies /api -> http://localhost:8787)
pnpm --filter @folio/web build        # vue-tsc + vite build (service worker precaches app + OCR assets)
pnpm --filter @folio/web preview      # http://localhost:4173
pnpm --filter @folio/web test         # unit + component tests
pnpm --filter @folio/web exec playwright test   # e2e against the preview build (needs `build` first)
```

**Features:** infinite/A4/Letter/iPad pages with blank/ruled/grid/dot backgrounds; pen, highlighter, eraser, shapes, arrows, text; selection with Clean Up (handwriting -> text, rough shapes -> shapes, non-destructive, "Restore ink"); automatic cleanup modes (keep / ask / auto); folders, tags, search across typed text, handwriting and labels; export Markdown, PNG, PDF and `.folio` (import too); optional sync and AI (summaries, outline, flashcards, ask my notes) when signed in to a folio server.

**Environment (optional, `apps/web/.env.local`):**
- `VITE_API_BASE` — folio-server URL (e.g. `/api` in dev, or `https://api.example.com`). Empty = local only.
- `VITE_CLERK_PUBLISHABLE_KEY` — enables account sign-in (Clerk loaded at runtime).

**With a server:** `FOLIO_AUTH_DEV=true pnpm server` (port 8787), start the web app with `VITE_API_BASE=/api`, then in the browser console run `localStorage['folio.devToken']='dev:alice'` and reload to sync without Clerk. Set `ANTHROPIC_API_KEY` on the server for AI features. `localStorage['folio.debug']='1'` exposes `window.__folio` (used by the e2e tests).
