# Changelog

All notable changes to folio are documented here.
Commits follow the [Gitmoji](https://gitmoji.dev/) convention.

## [v26.10.1-2702774] — 2026-10-1

- 👷 release: calver tags, one multi-arch image on GHCR, self-hosting docs
- ✨ web: read the server URL and Clerk key from config.json at runtime
- ✨ server: serve the web app next to the API, which moves under /api
- 🐛 web: wait for a notebook that is in the library but not synced yet
- ✅ recognition: give the shape accuracy test room on slower CI runners
- 💄 web: iPad layout on every screen size and a tighter notebook HUD
- ✨ fonts: Excalifont for hand-drawn text, add Permanent Marker and Playpen Sans
- 🍱 web: new folio icon and textmark; regenerate favicons
- ✨ server: route all AI requests through OpenRouter
- 🔧 serve the API on port 8989 and expose the dev server on the LAN
- 🐛 web: size the app from the visual viewport on iPad; ✨ auto-hide HUD slides away until a finger tap
- 🐛 renderer: fill ink through the stencil buffer so loops and highlighter reversals no longer produce odd fills
- 📝 README: new drawing features and keyboard shortcuts
- ✨ web: kit design tokens, decluttered HUD, blur/frame/edges panels, bundled fonts, PWA fullscreen, Excalidraw import and paste
- ✨ editor: hand, frame and blur tools, tool lock, Excalidraw key map, align/distribute, flick panning, per-tool colours
- ✨ recognition: deskew slanted lines, larger raster, output cleanup, word-level confidence
- ✨ renderer: rounded corners, polylines, frames with clipping, blur masks, highlighter edges, label sizes
- ✨ document: frames, blur masks, rounded corners, line points, highlighter edges, more fonts, quick colours; Excalidraw importer
- 💄 web: keep colour swatch rows on one line in the properties panel
- ✅ web: component + e2e tests for properties panel, colour picker, backgrounds and zen mode
- ✨ editor: new curved arrows get a default gentle bend
- ✅ editor: arrow editing and itemStyle tool tests
- ✨ editor: arrow waypoint/segment handles; ✅ renderer round-2 tests
- ✨ renderer: arrow routing (curved/elbow), arrowheads, dashed/dotted, fill styles, adaptive colours, dynamic background
- ✨ web: Excalidraw-style properties panel, colour picker, zen mode and background scaling UI
- 🐛 editor: fix style test typing
- ✨ editor: Excalidraw-style style API (itemStyle, setStyle, styleContext, bringForward/sendBackward)
- 🏷️ editor: add 'style' event to the editor event map
- ✨ Style, arrow routing and background scaling model; palette + canvas-aware colours
- ✅ web e2e: welcome arrow shaft is dark (WebGL)
- 👷 CI: typecheck, unit tests, build, e2e (incl. real-server sync) and Rust checks
- ✅ web sync e2e: merged state persists across an offline reload
- ✅ web: real multi-device sync e2e against the Rust server
- ✅ server: CORS preflight test (allowed vs foreign origin); cargo fmt
- 🎨 server: cargo fmt
- ✅ web e2e: cleanup keep/auto modes and selection restyling
- ✨ web: tool options popover restyles the current selection
- ✨ editor: setSelectionStyle applies colour/width/opacity to the selection
- 🐛 recognition: resample sparse strokes by arc length before shape fitting
- ⚡️ recognition: keep loro out of the worker bundle
- 🐛 renderer: arrow label background no longer washes out the shaft
- ✨ web: whole-group recognition regrouping, highlight clearing; 📝 README usage
- ✅ web: unit, component and Playwright e2e tests; offline-safe loro build; fixes
- ✨ web: PWA shell, services, library and notebook UI
- 🐛 sync: beforeCommitPulled hook so merged state is durable before pulledSeq advances
- ✨ recognition: engine, worker RPC, coordinator and planCleanup
- ✨ recognition: rasterizer, text heuristics and recognizers
- ✨ recognition: geometry, stroke grouping and shape recognizer
- ✅ editor: unit tests for camera, history, index, manipulation and input flows
- ✨ editor: framework-independent Editor Core
- ✨ renderer: WebGL/Canvas2D renderers, live ink layer, export helpers
- ✨ renderer: geometry builders, arrow resolution, hit testing
- ✨ Add folio-server: sync, assets, AI and Clerk auth
- ✅ Tests for markdown, folio, workspace, geometry and perf
- ✨ Loro-backed NotebookDocument, workspace doc, geometry, markdown/folio/search
- ✨ Add sync client and engine
- 🗃️ Implement persistence: SQLite-WASM/OPFS, IndexedDB, memory storage and DocPersister
- 🎉 This will begin to make things right.
