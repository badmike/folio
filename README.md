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
pnpm server       # Rust API on http://localhost:8787
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

**Features:** infinite/A4/Letter/iPad pages with blank/ruled/grid/dot backgrounds (toggle with `⌘'`); pen, highlighter (flat, round, slanted or curvy edges), eraser, shapes (sharp or round corners), lines with extra points, straight/curved/elbow arrows, text, frames (content moves and clips with the frame, can be removed while keeping the content) and blur masks (pixelate or Gaussian) for reveal effects; hand tool and flick panning with inertia; tool lock (`Q`); align and distribute; per-notebook quick colour swatches (hold a swatch to change it), each drawing tool remembers its own colours, a stylus eraser end or barrel button erases; a compact quick bar for switching colours while writing; hand-drawn (Excalifont), normal and code (Fira Code) fonts, plus more bundled fonts in a popover (Caveat, Kalam, Patrick Hand, Indie Flower, Architects Daughter, Shadows Into Light, Gloria Hallelujah, Permanent Marker, Playpen Sans); selection with Clean Up (handwriting -> text, rough shapes -> shapes, non-destructive, "Restore ink"); automatic cleanup modes (keep / ask / auto); temporary read-only lock per notebook (`Alt+R`); zen mode (`Alt+Z`); folders, tags, search across typed text, handwriting and labels; export Markdown, PNG, PDF and `.folio`; import `.folio` and `.excalidraw` files, paste Excalidraw content straight onto a page; optional sync and AI (summaries, outline, flashcards, ask my notes) when signed in to a folio server.

**Keyboard shortcuts** follow Excalidraw (press `?` in a notebook for the full list): `V` select, `H` hand, `R` rectangle, `D` diamond, `O` ellipse, `A` arrow, `L` line, `P` pen, `T` text, `E` eraser, `F` frame, `M` highlighter, `X` blur, `Q` tool lock, `⌘Z`/`⌘⇧Z` undo/redo, `⌘D` duplicate, `⌘G` group, `⌘[`/`⌘]` layer order, `⌘⇧arrows` align, `⌘+`/`⌘-`/`⌘0` zoom, `Shift+1` fit.

**Environment (optional, `apps/web/.env.local`):**

- `VITE_API_BASE` — folio-server URL (e.g. `/api` in dev, or `https://api.example.com`). Empty = local only.
- `VITE_CLERK_PUBLISHABLE_KEY` — enables account sign-in (Clerk loaded at runtime).

**With a server:** `FOLIO_AUTH_DEV=true pnpm server` (port 8787), start the web app with `VITE_API_BASE=/api`, then in the browser console run `localStorage['folio.devToken']='dev:alice'` and reload to sync without Clerk. Set `OPENROUTER_API_KEY` on the server for AI features (all AI requests go through OpenRouter). `localStorage['folio.debug']='1'` exposes `window.__folio` (used by the e2e tests).
