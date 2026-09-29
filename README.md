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
