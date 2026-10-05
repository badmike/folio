# Changelog

All notable changes to folio are documented here.
Commits follow the [Gitmoji](https://gitmoji.dev/) convention.

## [v26.10.5-9705a3a] — 2026-10-5

- 🐛 editor: stop iPadOS from swallowing quick Pencil strokes

## [v26.10.3-8d2152f] — 2026-10-3

- ✅ sync: compare the large base64 round trip without a deep equal
- ✅ e2e: pick the pen before drawing in the sync tests

## [v26.10.3-a00799a] — 2026-10-3

- ✨ renderer: highlighter ink blends like a real marker
- 🐛 renderer: no dark dot where a highlighter stroke starts a new pass
- 💄 web: lighter dialogs without separators
- ✨ web: insert, paste and drop images, and show them on the canvas
- ✨ editor: note and counter tools
- ✨ renderer: twelve new page patterns with previews in the picker
- ✨ renderer: highlighter ink builds up where a stroke goes over itself
- 💄 renderer: sloppy arrows bow and draw twice like shapes
- ✨ renderer: outline, diamond and crow's foot arrowheads
- 💄 web: new notebook dialog in the clean UI style
- ✨ web: add and remove quick colour swatches
- 🐛 editor: arrow bend points move, rotate and scale with the arrow
- ✨ web: Preferences submenu in the notebook menu
- 🐛 editor: Alt-drag moves a copy in one undo step
- ✨ editor: snap to objects and grid, and a wrap selection mode
- 💄 web: icon-only selection actions with clearer icons
- 💄 renderer: clean rounded corners
- 🐛 renderer: pattern dots keep their size when zooming in
- 🐛 editor: text editing lines up with the rendered text
- ✨ recognition: calibrate OCR to the writer and learn from corrections
- ✨ web: Tidy straightens handwriting lines and evens out their spacing
- ✨ editor: scribble over ink with the pen to erase it
- 💄 web: minimize icon, aligned checkbox and calmer sliders in tool options
- 💄 web: grouped search results and a tidier pages panel
- ✨ web: presenter mode and a compact notebook HUD
- 💄 toolbar: keep undo and redo outside the scrolling tool strip
- 🚸 web: open notebooks with the select tool
- ♻️ web: vendor Lucide icons with typed names

## [v26.10.2-6c04d28] — 2026-10-2

- 🍱 web: favicon.ico, padded touch icon and an Open Graph share card
- 💄 web: settings dialog with section nav and setting rows
- 💄 web: Figma-style library with sidebar search and quieter cards

## [v26.10.1-a405b9a] — 2026-10-1

- 🐛 renderer: match live highlighter caps to committed ink
- 🐛 sync: upload strokes written while pulling remote updates
- ✨ sync: stream notebook edits across devices while writing
- 💄 renderer: align arrow shafts and heads with Excalidraw roughness
- ⚡ editor: keep rapid Pencil strokes visible and reject resting palms

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
