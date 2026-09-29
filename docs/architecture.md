# Technical Architecture & Architecture Decisions

## 1. Purpose

This document defines the technical architecture for the **Semantic Infinite Canvas Note-Taking App**.

The product is a web-first, offline-first note-taking application optimized for iPad and Apple Pencil. It combines a high-performance infinite canvas with handwriting recognition, semantic objects, local-first persistence, cross-device synchronization, and AI-assisted understanding.

This document focuses on **how the system should be built** rather than the product requirements themselves.

The architecture should optimize for:

1. Extremely low-latency Pencil input
2. Reliable offline operation
3. Zero-loss local persistence
4. Seamless multi-device synchronization
5. Machine-readable handwriting
6. Large spatial canvases
7. Clear separation between document semantics and rendering
8. Future AI/semantic capabilities without redesigning the document format
9. A small-team-friendly infrastructure footprint

---

# 2. Core Architecture Principles

## 2.1 Local First

The local device contains a complete working copy of the user's notebooks.

The server is primarily responsible for:

- synchronization
- account management
- durable backup
- asset storage
- cloud AI
- cross-device coordination

Opening, editing, searching, and saving existing notes must not require a network connection.

The user should be able to take an entire lecture while offline.

---

## 2.2 Pencil Latency Takes Priority

Three architectural invariants apply throughout the system:

> **The network must never exist in the Pencil-to-pixel path.**

> **CRDT processing must never exist in the Pencil-to-pixel path.**

> **Recognition and AI must never exist in the Pencil-to-pixel path.**

The hot path should remain approximately:

```text
Apple Pencil
      ↓
Pointer Events
      ↓
In-memory stroke
      ↓
Immediate renderer
      ↓
Pixels
```

Everything else happens asynchronously.

---

# 3. High-Level Architecture

```text
┌─────────────────────────────────────────────────────┐
│                    Vue 3 PWA                        │
│                                                     │
│  ┌───────────────┐        ┌─────────────────────┐   │
│  │    Vue UI     │        │    Editor Core      │   │
│  │               │◄──────►│                     │   │
│  │ Toolbars      │        │ Commands            │   │
│  │ Navigation    │        │ Selection           │   │
│  │ Dialogs       │        │ Geometry            │   │
│  └───────────────┘        │ Document API        │   │
│                           └──────────┬──────────┘   │
│                                      │              │
│              ┌───────────────────────┼───────────┐  │
│              │                       │           │  │
│              ▼                       ▼           ▼  │
│         Rendering                Document    Recognition
│         Subsystem                 Model       Workers
│              │                       │           │
│      Canvas2D + WebGL              CRDT      Local ML
│                                      │           │
│                                      └─────┬─────┘
│                                            │
│                                SQLite-WASM + OPFS
└────────────────────────────────────────────┼────────┘
                                             │
                                        Sync Protocol
                                             │
                                             ▼
┌─────────────────────────────────────────────────────┐
│                  Rust Backend                       │
│                                                     │
│              Axum + Tokio + SQLx                    │
│                                                     │
│       Auth / Sync / Metadata / AI Gateway           │
│                                                     │
│              ┌──────────┴──────────┐                │
│              ▼                     ▼                │
│       SQLite / libSQL       S3-compatible           │
│                            Object Storage            │
└─────────────────────────────────────────────────────┘
```

---

# 4. Frontend Stack

## Decision

Use:

- Vue 3
- TypeScript
- Vite
- PWA architecture
- framework-independent editor core

The application should be a client-heavy SPA rather than relying on server-side rendering.

Nuxt is not required for the editor.

A separate marketing website can be introduced later if SEO or server rendering becomes relevant.

---

# 5. Framework Boundary

Vue must not become the canvas engine.

The architecture should explicitly separate:

```text
Vue Application
       ↓
Editor API
       ↓
Editor Core
       ↓
Document / Renderer / Recognition
```

Vue owns:

- application shell
- toolbar
- navigation
- file browser
- settings
- dialogs
- account UI
- inspector panels
- AI interfaces

The Editor Core owns:

- selection
- commands
- canvas state
- geometry
- object manipulation
- tools
- transformations
- undo/redo
- interaction state

This core should not depend directly on Vue.

For example:

```ts
interface Editor {
  document: DocumentHandle
  camera: Camera

  setTool(tool: Tool): void
  execute(command: Command): void
  undo(): void
  redo(): void

  select(ids: ObjectId[]): void
}
```

Vue consumes the editor API rather than owning editor state directly.

---

# 6. Page Model

The canonical hierarchy is:

```text
Workspace
└── Folder
    └── Notebook / File
        ├── Page
        ├── Page
        └── Page
```

Each page contains an independent canvas.

A page can be:

```text
InfiniteCanvas
```

or:

```text
FixedCanvas
  width
  height
  format: A4 | Letter | Custom
```

Both use the same object model and renderer.

The difference is primarily bounds, background behavior, export behavior, and navigation.

---

# 7. Semantic Document Model

The visible canvas is not the database.

The document model represents semantic objects independently from their rendering.

Example:

```text
Page
├── InkStroke
├── InkStroke
├── Text
├── Rectangle
├── Arrow
├── Image
└── Group
```

Every object receives a stable unique ID.

Example conceptual representation:

```ts
interface CanvasObject {
  id: ObjectId
  type: ObjectType

  position: Vec2
  rotation: number
  scale: Vec2

  createdAt: Timestamp
  updatedAt: Timestamp
}
```

Semantic relationships reference object IDs rather than coordinates.

Example:

```text
Arrow
├── source → object_a
└── target → object_b
```

Moving `object_b` therefore automatically updates the arrow.

---

# 8. Ink Representation

Raw handwriting must be preserved.

A completed stroke conceptually contains:

```text
InkStroke
├── id
├── points[]
│   ├── x
│   ├── y
│   ├── pressure
│   ├── tilt
│   └── timestamp
├── style
├── transform
└── recognition metadata
```

The exact binary representation can be optimized later.

Ink is never destructively replaced by OCR.

---

# 9. Stroke Lifecycle

While the Pencil is touching the screen, a stroke exists as an ephemeral in-memory object.

```text
pointerdown
     ↓
Create LiveStroke

pointermove
     ↓
Append samples
     ↓
Render immediately

pointerup
     ↓
Finalize stroke
     ↓
Persist
     ↓
Commit document mutation
     ↓
Queue recognition
     ↓
Queue synchronization
```

Persistence, recognition, CRDT updates, and synchronization happen after immediate rendering.

---

# 10. CRDT Stroke Strategy

Individual Pencil samples should not normally become independent CRDT entities.

Instead:

```text
Stroke
└── points[0...N]
```

is treated as one completed logical object.

Once completed, its point data should generally be immutable.

Transformations operate on metadata:

```text
transform
├── x
├── y
├── rotation
└── scale
```

rather than rewriting every point.

Deleting the stroke removes/tombstones the stroke object.

This decision must be validated during the CRDT prototype.

---

# 11. Rendering Architecture

The initial rendering architecture will be hybrid:

```text
                    Renderer
                       │
             ┌─────────┴─────────┐
             │                   │
       Immediate Ink       Retained Scene
             │                   │
         Canvas2D              WebGL
```

## Canvas2D

Canvas2D handles the actively drawn stroke.

Its purpose is minimizing Pencil-to-pixel latency.

## WebGL

WebGL handles the retained scene:

- existing strokes
- shapes
- arrows
- images
- backgrounds
- selections
- transformed objects

The renderer should remain behind a thin abstraction so WebGPU can later replace or augment WebGL without affecting the document model.

---

# 12. Renderer Interface

Conceptually:

```ts
interface Renderer {
  render(scene: Scene, camera: Camera): void
  resize(viewport: Size): void
  dispose(): void
}
```

Possible implementations:

```text
Canvas2DRenderer
WebGLRenderer
WebGPURenderer
```

The abstraction should remain intentionally small.

It must not attempt to abstract every graphics API feature.

---

# 13. Renderer Performance Validation

The hybrid architecture must be benchmarked on real iPad hardware.

The prototype should test approximately:

- active Apple Pencil stroke
- 10,000 visible objects
- 50,000 total objects
- pan
- pinch zoom
- selection
- transforms
- rough/hand-drawn geometry
- large zoom ranges

Measurements should prioritize:

1. Pencil latency
2. frame stability
3. dropped input events
4. memory usage
5. battery impact

Architecture should be changed if real hardware contradicts assumptions.

---

# 14. Spatial Index

Large pages should not iterate over every object during rendering or hit testing.

Maintain a spatial index over canvas objects.

Conceptually:

```text
World
  ↓
Spatial Index
  ↓
Viewport Query
  ↓
Visible Objects
  ↓
Renderer
```

An R-tree or similar structure should be evaluated.

The same index can support:

- rendering
- hit testing
- lasso selection
- nearby-object detection
- arrow snapping
- recognition grouping

---

# 15. Camera System

Page objects exist in world coordinates.

The camera defines:

```text
Camera
├── x
├── y
└── zoom
```

Rendering applies:

```text
World Coordinates
        ↓
Camera Transform
        ↓
Viewport Coordinates
```

No object should need its coordinates rewritten when the user pans or zooms.

---

# 16. Rough / Hand-Drawn Visual Style

The Excalidraw-like aesthetic belongs to the rendering layer, not the semantic model.

The document stores:

```text
Rectangle
```

not:

```text
ExcalidrawRectangle
```

A visual theme determines whether that rectangle appears:

- hand-drawn
- clean/geometric
- another future style

Rough.js or similar technology may initially generate rough geometry behind the renderer abstraction.

It can later be replaced without migrating notebook data.

---

# 17. Text Rendering

Text uses a hybrid architecture.

## Editing

While editing text, use DOM-based editing where practical.

Benefits include:

- cursor handling
- selection
- IME
- keyboard interaction
- accessibility
- browser text input behavior

## Committed Text

Committed text becomes part of the retained scene.

The renderer can optimize its display independently.

This avoids implementing a complete text editor inside WebGL.

---

# 18. Handwritten Font

Cleaned handwriting should use an open-source handwritten font by default.

The specific font is a theme decision rather than a document-format decision.

A text object therefore stores semantic text and optional styling information rather than depending on one particular font implementation.

---

# 19. Local Persistence

The preferred architecture is:

```text
SQLite-WASM
      │
      └── OPFS-backed database

OPFS
      │
      └── Large binary assets where appropriate
```

SQLite should manage structured local application state.

Potential tables include:

```text
notebooks
pages
objects
operations
recognition_results
search_index
sync_state
settings
```

Large binary assets may live separately in OPFS and be referenced from SQLite.

---

# 20. Why SQLite-WASM

SQLite provides useful properties for this application:

- transactions
- mature recovery behavior
- schema migrations
- local queries
- full-text search
- indexing
- structured metadata
- portability

It also allows the client to use database semantics without depending on the server.

However, SQLite-WASM + OPFS must be validated specifically on supported iPad/Safari versions before becoming irreversible infrastructure.

Reliability takes precedence over architectural elegance.

---

# 21. Operation Journal

The application maintains a local append-oriented operation journal.

Examples:

```text
AddStroke
DeleteObject
MoveObject
ResizeObject
CreateText
UpdateText
ConvertInkToText
ConnectObjects
```

The journal serves several purposes:

- crash recovery
- undo/redo
- diagnostics
- persistence batching
- document reconstruction where useful

It is separate from CRDT internals.

---

# 22. Undo / Redo

Undo is local to the user's current editing session/device.

It should behave like an editor history rather than global distributed time travel.

Example:

```text
iPad:
  AddStroke
  AddStroke
  MoveObject

Undo
      ↓

Undo MoveObject
```

A remote synchronized action from another device should not unexpectedly become the next local undo operation.

---

# 23. CRDT Architecture

The system uses a CRDT from the beginning because cross-device offline editing must merge without routine user-visible conflicts.

However, the application should not implement its own low-level CRDT algorithm.

Architecture:

```text
Application Operations
        ↓
Document Layer
        ↓
Established CRDT
        ↓
Sync Layer
```

Application semantics remain ours.

Distributed convergence belongs to the CRDT library.

---

# 24. CRDT Evaluation

Two candidates should be prototyped:

- Loro
- Automerge

The final decision should be empirical.

Do not benchmark generic collaborative text editing.

Create a representative notebook workload.

Example:

```text
Notebook
├── 20 pages
├── 50,000 strokes
├── 5,000 semantic objects
├── text
├── arrows
├── groups
└── images
```

Simulate:

```text
Device A offline
        +
Device B offline
        ↓
Independent edits
        ↓
Reconnect
        ↓
Merge
```

Measure:

- merge correctness
- merge latency
- memory
- document size
- startup time
- incremental update size
- WASM/browser compatibility
- developer ergonomics

The winner becomes the document CRDT.

---

# 25. Sync Architecture

The server behaves primarily as a replication endpoint.

Conceptually:

```text
Device A ─┐
          │
          ▼
      Sync Server
          ▲
          │
Device B ─┘
```

The server does not need to own the editing experience.

Clients remain fully usable without it.

---

# 26. Sync Lifecycle

A typical edit follows:

```text
User action
    ↓
Immediate local UI
    ↓
Operation journal
    ↓
Local document state
    ↓
Local persistence
    ↓
CRDT update
    ↓
Sync queue
    ↓
Network available?
    │
   YES
    ↓
Server replication
```

Network failure simply stops the pipeline near the bottom.

Everything above it continues working.

---

# 27. Conflict Strategy

The target user experience is:

> The user should almost never encounter a manual sync-conflict dialog.

CRDT convergence handles concurrent document modifications.

Where automatic semantic resolution is impossible, the system should preserve data rather than silently discard one side.

Conflict-copy behavior may still exist as an emergency recovery mechanism, but should not be normal synchronization UX.

---

# 28. Local Search

Search should work completely offline.

SQLite Full-Text Search should be evaluated as the primary local text index.

Index:

- typed text
- recognized handwriting
- notebook titles
- tags
- semantic labels

Example:

```text
Search: "eigenvector"
        ↓
SQLite FTS
        ↓
Matching semantic objects
        ↓
Notebook + Page + Object ID
        ↓
Navigate camera to result
```

Semantic/vector search is intentionally deferred.

---

# 29. Recognition Architecture

Recognition runs outside the main UI thread.

```text
Ink
 ↓
Recognition Coordinator
 ↓
Web Worker(s)
 │
 ├── Stroke Grouper
 ├── Handwriting Recognizer
 └── Shape Recognizer
 ↓
Recognition Result
 ↓
Document Semantic Metadata
```

Future recognizers can include:

```text
MathRecognizer
DiagramRecognizer
LayoutRecognizer
SemanticRecognizer
```

The system should remain modular internally without defining a public plugin API during MVP.

---

# 30. Handwriting Grouping

Recognition should operate primarily on words and grouped lines/blocks rather than isolated strokes.

Conceptually:

```text
Raw strokes
    ↓
Temporal grouping
    ↓
Spatial grouping
    ↓
Candidate words
    ↓
Candidate lines
    ↓
Handwriting recognition
```

Context can improve recognition accuracy.

Recognition must initially support:

- English
- German

Priorities are:

1. accuracy
2. latency
3. offline capability
4. multilingual quality
5. battery efficiency
6. mathematical recognition

---

# 31. Recognition Model Selection

Do not choose an ML runtime first.

Choose the recognition model based primarily on actual handwriting accuracy.

Evaluation data should include real:

- German handwriting
- English handwriting
- mixed-language notes
- lecture terminology
- abbreviations
- messy fast handwriting

Only after choosing acceptable models should the team determine whether they run through:

- WASM
- WebGPU
- ONNX-compatible runtime
- another browser ML runtime
- Rust/WASM

Architecture must serve recognition quality rather than artificially limiting model selection.

---

# 32. Local + Cloud Recognition

Recognition follows a progressive-refinement model.

```text
Handwriting
     ↓
Local recognition
     ↓
Immediate semantic result
     ↓
Network available
     ↓
Optional cloud refinement
```

Example:

```text
Local:
"eigen vector"

Cloud:
"eigenvector"
```

Cloud refinement may update machine-readable semantic text.

It should not unexpectedly rewrite already-visible cleaned notes.

The distinction is:

```text
Original Ink
Visible Representation
Semantic Interpretation
```

These are related but independent.

---

# 33. Shape Recognition

Shape recognition should initially be algorithmic where possible rather than automatically requiring ML.

Recognize:

- line
- arrow
- rectangle
- ellipse/circle
- triangle
- diamond

Example:

```text
rough ink
   ↓
Shape Recognizer
   ↓
confidence = 0.97
   ↓
Rectangle semantic object
   ↓
rough-style renderer
```

Original ink can remain available for undo/recovery.

---

# 34. Backend Stack

The backend uses:

- Rust
- Axum
- Tokio
- SQLx

The backend should remain deliberately thin.

Responsibilities:

```text
Authentication integration
Synchronization
Notebook metadata
Device/account coordination
Object storage authorization
Cloud recognition
AI gateway
Rate limiting
Operational telemetry
```

The server does not perform ordinary canvas rendering or local editing logic.

---

# 35. Backend API

Conceptual API areas:

```text
/auth
/sync
/notebooks
/assets
/ai
```

Examples:

```text
POST /sync/push
GET  /sync/pull

POST /assets/upload
GET  /assets/:id

POST /ai/recognize
POST /ai/summarize
POST /ai/ask
```

The exact API style should be decided during implementation.

The architecture does not require REST specifically.

---

# 36. Server Database

Use a SQLite-compatible database abstraction initially.

The application should retain the ability to run against SQLite/libSQL-style infrastructure without tightly coupling business logic to one deployment vendor.

The database stores primarily:

- users
- devices
- notebooks metadata
- sync metadata
- asset metadata
- AI job metadata
- quotas
- account state

The bulk canvas document does not need to be represented as thousands of conventional server database rows.

---

# 37. SQL Access

Use SQLx for Rust database access.

Prefer explicit SQL over introducing a large ORM abstraction.

Benefits include:

- clear queries
- low abstraction overhead
- compile-time query checking where applicable
- straightforward migrations

---

# 38. Authentication

Use managed authentication rather than building authentication infrastructure.

Initial provider:

Clerk

Support should ultimately include combinations of:

- Apple
- Google
- email
- passkeys where appropriate

The application should still support a completely local mode without an account.

---

# 39. Local-First Account Experience

Account creation should not block initial note-taking.

Preferred flow:

```text
Open application
      ↓
Create local notebook
      ↓
Start writing immediately
      ↓
Optional:
"Create account to sync"
```

After authentication, existing local notebooks can be associated with the account and synchronized.

---

# 40. Object Storage

Use S3-compatible object storage.

Do not architect around a specific vendor.

Potential providers can therefore include:

- AWS S3
- Cloudflare R2
- Backblaze B2
- MinIO
- compatible future providers

Store objects such as:

- images
- large CRDT snapshots
- notebook packages
- exports
- previews
- other large binary assets

---

# 41. Portable Notebook Format

The application should have a real portable notebook format.

Conceptually:

```text
lecture.note
├── manifest.json
├── document.crdt
├── assets/
│   ├── image-001
│   ├── image-002
│   └── ...
└── preview.webp
```

The exact container format is an implementation detail.

The important architectural property is that notebooks can eventually be:

- exported
- imported
- backed up
- migrated
- inspected by future versions

The cloud database must not become the only meaningful representation of a notebook.

---

# 42. AI Architecture

Cloud AI requests go through the Rust backend.

Clients should not contain provider API keys.

Architecture:

```text
Client
  ↓
Rust AI Gateway
  ↓
Model abstraction
  ├── Provider A
  ├── Provider B
  └── Future provider
```

The AI gateway is responsible for:

- authentication
- quotas
- provider selection
- model selection
- retries
- privacy controls
- cost controls
- observability

The product should not couple its document format to any particular AI provider.

---

# 43. AI Context

AI should consume semantic notebook information wherever possible.

Avoid defaulting to screenshots of pages.

Preferred:

```text
Semantic objects
     ↓
Structured context
     ↓
AI
```

instead of:

```text
Screenshot
     ↓
Vision model
```

Vision models can still be useful for unresolved drawings or diagrams.

But machine-readable semantic content should be the primary AI interface.

---

# 44. AI Output

Deliberate AI-generated content should become normal notebook content.

For example:

```text
Generate Lecture Summary
          ↓
AI Gateway
          ↓
Markdown
          ↓
Text/Markdown Object
          ↓
Notebook
```

The user can then:

- edit it
- move it
- delete it
- export it
- link it

AI output should not exist in a separate inaccessible metadata layer.

---

# 45. AI Features

Future capabilities include:

- summarize page
- summarize lecture
- Ask My Notes
- explain selected content
- generate flashcards
- generate questions
- generate study guide
- find related notes
- suggest concept links

Vector databases and embedding infrastructure are intentionally deferred.

Stable semantic object IDs provide sufficient groundwork for later semantic indexing.

---

# 46. Privacy Model

MVP uses conventional SaaS security rather than end-to-end encrypted notebooks.

Use:

- TLS in transit
- encrypted managed storage where available
- secure authentication
- scoped object access
- server-side authorization

This allows cloud recognition and AI processing without introducing E2EE key-management complexity into the initial product.

End-to-end encryption can be reconsidered separately if product requirements change.

---

# 47. Deployment

Initial deployment should remain simple.

```text
Vue PWA
   ↓
CDN / Static Hosting

Rust API
   ↓
Small Container Deployment

SQLite/libSQL-compatible DB

S3-compatible Object Storage
```

Do not introduce Kubernetes for MVP.

Infrastructure should optimize for:

- small-team operation
- low cost
- easy deployment
- simple backups
- straightforward observability

Scaling architecture can change once real usage demonstrates where scaling is necessary.

---

# 48. Monorepo

Use a monorepo.

Conceptual structure:

```text
/apps
  /web
  /server

/packages
  /editor
  /renderer
  /document
  /recognition
  /sync
  /ui

/crates
  /...
```

Not every package needs to exist immediately.

Create boundaries when they provide real architectural value.

Avoid splitting code solely to make the repository look architecturally sophisticated.

---

# 49. TypeScript vs Rust/WASM

Do not rewrite the entire client core in Rust prematurely.

Initial principle:

> Implement client functionality in TypeScript unless profiling demonstrates a meaningful reason to move it.

Candidates for later Rust/WASM optimization include:

- geometry
- spatial indexing
- stroke simplification
- serialization
- recognition preprocessing
- heavy document operations

Migration should be evidence-driven.

---

# 50. Background Workers

Expensive work should be moved off the main thread.

Potential workers:

```text
Recognition Worker
Persistence Worker
Search/Index Worker
Sync Worker
Geometry Worker
```

These do not necessarily need to become five separate workers immediately.

The goal is isolation of expensive work, not maximum worker count.

The main thread should prioritize:

- input
- immediate rendering
- interaction
- essential UI updates

---

# 51. Autosave and Crash Recovery

Every completed stroke should become durable quickly.

The operation journal should be flushed aggressively enough that a browser crash does not lose meaningful lecture content.

The target should be:

> A crash may lose the currently active stroke, but should not lose the previous several minutes of writing.

Recovery flow:

```text
Application launch
      ↓
Load latest durable state
      ↓
Check operation journal
      ↓
Replay unapplied operations
      ↓
Recover notebook
```

Periodic compaction prevents the journal from growing indefinitely.

---

# 52. Failure Philosophy

When forced to choose between:

```text
Data consistency
```

and:

```text
silently losing notes
```

preserve the data.

Unexpected duplicate/recovered objects are preferable to deleting user-created content without recovery.

The system should be designed around the assumption that notes may represent hours of irreplaceable classroom work.

---

# 53. Testing Strategy

Initial testing uses conventional:

- unit tests
- integration tests
- browser tests where useful

Particular attention should nevertheless be given to data integrity.

High-value automated tests include:

### CRDT convergence

```text
A + B concurrent edits
        ↓
merge
        ↓
A == B
```

### Crash recovery

Terminate persistence at different points and verify recovery.

### Offline behavior

Ensure all core editing features work with networking completely unavailable.

### Serialization

Ensure notebook export/import round-trips without semantic changes.

### Migration

Ensure older notebook schemas upgrade without data loss.

Performance testing on real iPad hardware should accompany major renderer/input changes.

---

# 54. Observability

Server observability should include:

- API errors
- sync failures
- sync latency
- AI failures
- storage errors
- authentication errors

Client diagnostics should be privacy-conscious but capable of identifying:

- database corruption
- failed persistence
- failed CRDT merge
- renderer crashes
- recognition failures

A future diagnostic export could package technical logs without including notebook content unless explicitly authorized by the user.

---

# 55. Explicitly Deferred Decisions

The following decisions should be resolved through prototypes rather than architectural preference.

## CRDT

Evaluate:

- Loro
- Automerge

using the actual notebook workload.

## Local ML Runtime

Choose handwriting models based on real German/English accuracy first.

Then determine whether they run through:

- WASM
- WebGPU
- ONNX-compatible runtime
- another runtime

## SQLite-WASM + OPFS

Validate reliability on supported iPad/Safari versions.

Maintain an escape path to a different browser persistence architecture if testing reveals reliability problems.

## WebGPU

WebGL is the initial retained renderer target.

WebGPU should be evaluated later based on measurable benefit.

---

# 56. Rejected / Avoided Architecture

## Native iOS as primary application

Rejected because the product is web-first.

A native shell remains possible later.

## Server-authoritative editing

Rejected because note-taking must remain fully functional offline.

## Full document uploads after every change

Rejected because they are inefficient and create poor multi-device conflict behavior.

## Custom CRDT implementation

Rejected because distributed convergence is not a differentiating product capability.

Use a mature CRDT and build product semantics above it.

## Vue-driven canvas objects

Rejected because thousands of reactive framework components are inappropriate for the main rendering engine.

## DOM-based infinite canvas

Rejected for the main scene because of expected object count and rendering requirements.

DOM remains useful for UI and active text editing.

## Cloud-only handwriting recognition

Rejected because recognition should remain useful offline.

## AI in the editing hot path

Rejected because Pencil interaction must not depend on network or inference latency.

## Kubernetes for MVP

Rejected because the operational complexity is unjustified.

---

# 57. Implementation Sequence

Architecture should be proven in vertical slices.

## Phase 0 — Technical Spikes

Before building the full product, validate the riskiest assumptions.

### Rendering spike

Build:

- Pointer Event capture
- Canvas2D live stroke
- WebGL retained strokes
- pan
- zoom
- 10k–50k object stress test

Test on actual iPad hardware.

### Persistence spike

Build:

```text
Pointer
 ↓
Stroke
 ↓
Journal
 ↓
SQLite-WASM / OPFS
 ↓
Kill application
 ↓
Recover
```

### CRDT spike

Compare Loro and Automerge with realistic notebook data.

### Recognition spike

Collect representative English/German handwriting and compare candidate recognition systems.

These four experiments should happen before significant product UI work.

---

# 58. Phase 1 — Editor Foundation

Implement:

- framework-independent Editor Core
- page model
- infinite canvas
- fixed canvas
- camera
- pointer input
- Pencil/finger differentiation
- pen
- highlighter
- eraser
- selection
- transforms
- undo/redo
- local persistence

At this point the application should already be usable as a basic offline notebook.

---

# 59. Phase 2 — Semantic Drawing

Add:

- shape recognition
- arrows
- object connections
- rough rendering
- text objects
- handwriting grouping
- handwriting recognition
- semantic text metadata
- Clean Up
- local full-text search

This transforms the product from a drawing canvas into a machine-readable notebook.

---

# 60. Phase 3 — Accounts and Sync

Add:

- Clerk authentication
- local → account migration
- Rust/Axum backend
- CRDT synchronization
- S3-compatible assets
- multiple devices
- conflict/convergence testing

Offline behavior must remain unchanged after sync is introduced.

---

# 61. Phase 4 — Cloud Intelligence

Add:

- cloud recognition refinement
- AI gateway
- summaries
- Markdown generation
- Ask My Notes
- semantic links

AI builds on the existing semantic document model rather than becoming a parallel representation of notebooks.

---

# 62. Phase 5 — Deeper Semantic Understanding

Introduce richer object types:

```text
Heading
Paragraph
List
Equation
Definition
Question
Example
Diagram
Table
Concept
```

Recognition evolves from:

> "What text is here?"

toward:

> "What does this region of the notebook represent?"

This enables richer exports, linking, search, and AI reasoning.

---

# 63. Initial Technology Stack

The current working stack is therefore:

| Layer | Decision |
|---|---|
| Frontend | Vue 3 + TypeScript |
| Build | Vite |
| Application | SPA / PWA |
| Editor | Framework-independent custom core |
| Immediate Ink | Canvas2D |
| Retained Rendering | WebGL |
| Future Rendering | WebGPU evaluation |
| Rough Visuals | Rough.js-style rendering behind abstraction |
| Local Database | SQLite-WASM + OPFS, pending validation |
| Local Search | SQLite FTS |
| Crash Recovery | Append-oriented operation journal |
| Distributed State | CRDT |
| CRDT Candidates | Loro / Automerge |
| Backend | Rust |
| Server Framework | Axum |
| Async Runtime | Tokio |
| SQL | SQLx |
| Server Database | SQLite/libSQL-compatible |
| Authentication | Clerk |
| Assets | S3-compatible object storage |
| Local ML | Model-first evaluation |
| Cloud AI | Provider-independent Rust gateway |
| Repository | Monorepo |
| Deployment | Static frontend + small Rust container |

---

# 64. Architecture Summary

The application is fundamentally a **local-first semantic editor**, not a cloud drawing application.

The critical flow is:

```text
                    ┌─────────────┐
                    │ Apple Pencil│
                    └──────┬──────┘
                           ↓
                    Immediate Ink
                           ↓
                    ┌─────────────┐
                    │ Editor Core │
                    └──────┬──────┘
                           ↓
                  Semantic Document
                           ↓
          ┌────────────────┼─────────────────┐
          ↓                ↓                 ↓
     Persistence       Recognition         Search
          ↓                ↓                 ↓
      SQLite/OPFS      Semantic Data     SQLite FTS
          │
          ↓
        CRDT
          │
          ↓
         Sync
          │
          ↓
      Rust Backend
          │
     ┌────┴───────────┐
     ↓                ↓
 Cloud Storage        AI
```

The architecture deliberately separates:

**input → document → semantics → presentation → intelligence**

This separation is the central technical decision.

It allows the product to begin as an extremely responsive offline Pencil notebook while providing a credible path toward machine-readable notes, semantic diagrams, Markdown export, concept linking, and AI-assisted learning without replacing the core editor architecture later.