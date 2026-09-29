# Semantic Infinite Canvas Note-Taking App

## 1. Product Vision

Build a **web-first, offline-first note-taking application optimized for iPad + Apple Pencil and classroom use**.

The application combines:

- Figma's spatial infinite-canvas model
- Excalidraw's hand-drawn visual language
- The speed and fluidity of handwriting
- The searchability and structure of digital text
- AI-native understanding of notes

The core philosophy is:

> **Ink is the input method. Structured, machine-readable knowledge is the underlying product.**

A student should be able to enter a lecture, open a notebook, and immediately start writing with Apple Pencil without thinking about tools, OCR, formatting, or organization.

The application quietly converts handwriting, shapes, arrows, and eventually diagrams into semantic information while preserving the original strokes.

After class, the same notes should be searchable, selectable, linkable, exportable as Markdown, and understandable by AI.

---

# 2. Primary Success Scenario

The core product test is:

> A student can take a complete 90-minute university lecture using Apple Pencil, mixing handwriting, diagrams, arrows, shapes, and spatial organization. The app works entirely offline and never interrupts the writing experience.
>
> After the lecture, the student can search what they wrote, clean up handwriting and shapes, copy recognized text, export useful Markdown, link concepts, summarize the lecture, and ask questions about their notes.

Anything that does not contribute to this workflow should initially be considered secondary.

---

# 3. Platform Strategy

## Web First

The primary application should be a modern web application optimized for:

- iPad + Apple Pencil
- Desktop browsers
- Touch devices
- Keyboard and mouse
- Trackpad

It should be installable as a PWA where supported.

The architecture should not depend on native iOS frameworks such as PencilKit, Core Data, or CloudKit.

A native iPad wrapper may be considered later if browser limitations prevent important Apple Pencil functionality.

## Apple Pencil Input

Use browser Pointer Events as the primary input abstraction.

Capture where available:

- position
- pressure
- tilt
- pointer type
- timestamps
- coalesced pointer events

The drawing engine must distinguish between:

- Apple Pencil / stylus
- touch
- mouse

Default interaction on iPad:

**Pencil → write/draw**

**Finger → pan/zoom/select**

This should make the canvas feel immediately natural without requiring constant tool switching.

---

# 4. Offline-First Requirement

Offline operation is a fundamental architectural requirement rather than an optional feature.

The complete core note-taking workflow must work without an internet connection.

Offline functionality must include:

- creating notebooks
- creating canvases/pages
- handwriting
- drawing
- erasing
- selection
- shapes
- undo/redo
- autosave
- local handwriting recognition where technically feasible
- local search/indexing where feasible
- opening existing notes
- Markdown export

Cloud synchronization happens when connectivity becomes available.

AI functionality that requires remote models may gracefully become available when online, but **loss of connectivity must never prevent taking notes**.

---

# 5. Information Model

The fundamental hierarchy is:

**Workspace → Folder → File/Notebook → Canvas → Objects**

A file represents a notebook or lecture document.

Each file contains one or more canvases.

A canvas can use either:

### Infinite Canvas

A spatially unlimited workspace similar to Figma or Excalidraw.

Users can freely position notes, diagrams, images, and other objects.

### Fixed Page

A bounded canvas such as:

- A4
- Letter
- iPad aspect ratio
- custom dimensions

Fixed pages are useful when the user intends to print or export the document.

The distinction should remain lightweight. Both canvas types use the same underlying object model and rendering engine.

---

# 6. Canvas Background

Each canvas supports configurable backgrounds:

- blank
- ruled
- square grid
- dot grid
- custom spacing
- custom opacity
- background color

The background is a canvas property rather than a collection of rendered objects.

It therefore remains performant regardless of zoom level or canvas size.

---

# 7. Semantic Canvas Object Model

Everything placed on the canvas should eventually be represented as an object rather than flattened pixels.

Core object types include:

- InkStroke
- Text
- Shape
- Arrow
- Image
- Group
- Frame/Page
- Link
- EmbeddedDocument

Later semantic types may include:

- Equation
- Heading
- Paragraph
- List
- Table
- Diagram
- CodeBlock
- Concept
- Citation

Objects should have stable IDs so relationships can exist independently of visual position.

For example:

`Arrow A → connects Shape B and Text C`

rather than simply storing an arrow at particular coordinates.

This semantic model is essential for later AI understanding.

---

# 8. Handwriting Architecture

Handwriting must never be treated as disposable input.

The application stores two representations:

### Original Ink

The exact strokes produced by the user.

Store properties such as:

- coordinates
- timestamps
- pressure
- tilt where available
- stroke width
- tool
- color

### Semantic Representation

A machine-readable interpretation associated with those strokes.

Example:

```text
InkGroup
 ├─ strokes: [...]
 ├─ recognizedText: "Newton's Second Law"
 ├─ confidence: 0.96
 ├─ semanticType: "heading"
 └─ recognitionVersion: ...
```

The original strokes remain available even after recognition.

Recognition must therefore always be:

**non-destructive and reversible.**

---

# 9. Handwriting → Text UX

Recognition happens asynchronously after writing.

The system should avoid visibly changing text while the user is actively writing.

Two primary workflows should be supported.

## Automatic Cleanup

After a short inactivity period, high-confidence handwriting may be converted into clean text using an Excalidraw-style handwritten font.

The conversion should preserve approximately:

- original position
- size
- line breaks
- rotation
- spatial relationships

## Manual Cleanup

Users can select handwriting and invoke:

**Clean Up**

The system then converts recognizable handwriting and shapes into their cleaner semantic equivalents.

This is especially useful when recognition confidence is lower or the student wants the original handwritten appearance during class.

A global option should eventually allow users to choose between:

- Keep handwriting
- Automatically clean up
- Ask before cleanup

Regardless of visual mode, recognized machine-readable text should remain associated with the original strokes.

---

# 10. Excalidraw-Like Visual Language

Cleaned content should retain the personality of handwritten notes rather than becoming sterile document typography.

Use an Excalidraw-inspired visual system:

- handwritten-style font
- slightly imperfect shapes
- hand-drawn arrows
- subtle irregularity
- minimal UI chrome

The result should feel like **clean handwriting**, not like handwriting pasted into Microsoft Word.

---

# 11. Shape Recognition

Roughly drawn shapes should be recognized and optionally improved.

Phase 1 shapes:

- rectangle
- circle/ellipse
- line
- arrow
- triangle
- diamond

Example:

A student roughly draws:

`[ wonky rectangle ]`

The system recognizes:

`Shape(type: rectangle)`

and replaces its visual representation with a cleaner Excalidraw-style rectangle.

The original stroke remains recoverable.

---

# 12. Smart Arrows and Connections

Arrows should become semantic connections.

When an arrow is drawn close to another object, its endpoints should optionally snap to that object.

For example:

```text
[Force] ─────→ [Acceleration]
```

Internally:

```text
Arrow
  from: object_123
  to: object_456
```

Moving either object automatically updates the arrow.

This becomes particularly important in Phase 2 because diagrams can then be interpreted as relationships rather than collections of unrelated strokes.

---

# 13. Drawing Tools

The initial toolbar should remain intentionally small.

Primary tools:

- Pen
- Highlighter
- Eraser
- Selection
- Shape
- Arrow
- Text

Each drawing tool supports appropriate properties such as:

- width
- color
- opacity
- pressure sensitivity

Tool configuration can persist per notebook.

Avoid recreating a full illustration application.

The product is optimized for **thinking and note-taking**, not digital painting.

---

# 14. Selection

Support:

- tap selection
- rectangle selection
- lasso selection
- multi-select

Selected content can be:

- moved
- scaled
- rotated
- duplicated
- grouped
- deleted
- cleaned up
- copied
- linked

Selection should operate on semantic objects where possible.

---

# 15. Search

Search is a first-class feature.

Search should cover:

- typed text
- recognized handwriting
- notebook titles
- tags
- eventually semantic concepts

Searching for:

`Fourier transform`

should locate handwritten occurrences even if the handwriting has never been visually converted into text.

Results should navigate directly to the relevant canvas location and zoom to the matching content.

---

# 16. Markdown as a First-Class Export

Markdown export should not merely OCR every canvas and concatenate the result.

The semantic model should reconstruct useful document structure.

For example, spatial notes containing:

- heading
- paragraph
- bullets
- equation
- diagram

might export as:

```md
# Newton's Second Law

Force is proportional to acceleration.

- Force: F
- Mass: m
- Acceleration: a

F = ma

[Diagram]
```

The spatial canvas remains the canonical note representation, while Markdown provides a portable linear representation.

---

# 17. Phase 2 — Semantic Understanding

Phase 1 answers:

> "What did the user write?"

Phase 2 should answer:

> "What does this collection of objects represent?"

The recognition pipeline should progressively identify:

- headings
- paragraphs
- bullet lists
- equations
- tables
- diagrams
- labels
- relationships
- definitions
- examples
- questions
- concepts

For example, handwriting plus arrows and boxes could be interpreted as:

```text
ConceptMap
 ├─ Photosynthesis
 │   ├─ requires → Light
 │   ├─ consumes → CO₂
 │   └─ produces → Glucose
```

This semantic representation becomes the foundation for AI functionality.

---

# 18. AI Layer

AI should operate primarily on the machine-readable semantic representation rather than screenshots of the canvas.

Users should eventually be able to:

- summarize a lecture
- generate an outline
- ask questions about notes
- explain a selected concept
- identify important concepts
- generate flashcards
- generate study questions
- find related notes
- link concepts between lectures

Example:

> "Where have I previously written about eigenvectors?"

The system can search semantic representations across notebooks and return relevant canvas locations.

AI should be layered **on top of** a useful standalone notebook rather than being required for basic operation.

---

# 19. Concept Linking

Every semantic object has a stable identifier.

This allows links between:

- text blocks
- canvas locations
- concepts
- pages
- notebooks

Users could select "Fourier Transform" and choose:

**Link to...**

Then connect it to another lecture or concept.

Phase 2 can suggest these relationships automatically.

---

# 20. Rendering Architecture

The application should not represent the entire infinite canvas as DOM elements.

Use a dedicated high-performance rendering layer.

Candidate technologies should be evaluated around:

- Canvas 2D
- WebGL
- WebGPU
- hybrid DOM/canvas rendering

Rendering must be viewport-aware.

Only objects visible within or near the current viewport should require expensive rendering work.

Conceptually:

```text
Document Model
      ↓
Spatial Index
      ↓
Visible Objects
      ↓
Rendering Engine
```

A spatial index such as an R-tree or equivalent can efficiently determine which objects intersect the viewport.

---

# 21. Coordinate System

Use world coordinates independent of screen coordinates.

```text
Canvas/world space
        ↓
Camera transform
        ↓
Viewport/screen space
```

The camera contains:

- x
- y
- zoom

This makes pan and zoom operations independent of individual objects and allows extremely large canvases.

---

# 22. Input Pipeline

Drawing latency is critical.

Pointer input should follow approximately:

```text
Pointer Event
      ↓
Raw Stroke Buffer
      ↓
Immediate Rendering
      ↓
Stroke Simplification
      ↓
Persistent Ink Object
      ↓
Background Recognition
      ↓
Semantic Metadata
```

Recognition, persistence, synchronization, and AI processing must **never block the drawing loop**.

Visual ink should appear immediately.

---

# 23. Local Persistence

The application should follow a local-first architecture.

The local browser database is the primary working copy.

Potential browser technologies include:

- IndexedDB
- OPFS
- Web Workers
- Service Workers
- WASM

Large binary assets such as imported images should not necessarily be stored directly inside the primary structured database.

The persistence layer should support:

- incremental writes
- crash recovery
- migrations
- background indexing
- offline use

---

# 24. Recognition Pipeline

Recognition should be modular.

```text
Raw Ink
   ↓
Stroke Grouping
   ↓
Recognition
   ↓
Confidence Scoring
   ↓
Semantic Object
   ↓
Optional Visual Cleanup
```

Different recognizers may eventually handle:

- handwriting
- shapes
- equations
- diagrams

Recognition should ideally run in a Web Worker so processing does not interfere with drawing.

Where practical, local models can run through WASM or browser ML runtimes.

Cloud recognition may optionally improve results when online, but the data model must not depend upon it.

---

# 25. Undo/Redo

Use an operation/command-based history rather than storing complete canvas snapshots.

Examples:

```text
AddStroke
DeleteObject
MoveObject
TransformObject
ConvertInkToText
ConvertInkToShape
ConnectObjects
```

This makes semantic transformations reversible.

For example:

`handwriting → recognized text`

must be undoable back to the original handwriting.

---

# 26. Synchronization

Synchronization is secondary to local reliability.

The fundamental rule should be:

> **Writing locally must never wait for the network.**

Local changes are committed immediately.

When connectivity exists, changes synchronize with the backend.

The architecture should eventually support conflict-safe synchronization at the object/operation level rather than uploading an entire notebook after every edit.

Because the initial product is personal rather than collaborative, real-time multiplayer infrastructure is explicitly outside the MVP.

---

# 27. File Management

Users can organize notebooks using:

- folders
- nested folders
- titles
- tags
- creation date
- modification date
- thumbnails

Operations include:

- create
- duplicate
- rename
- delete
- move
- export

Keep this system intentionally simpler than the canvas itself.

---

# 28. Import / Export

Phase 1:

- Markdown
- PNG
- PDF
- native application format

Later:

- SVG
- structured JSON
- images
- PDF/slide annotation

PDF annotation should not dictate the initial architecture because the primary workflow is blank-canvas note-taking.

---

# 29. Performance Targets

The application should target the perception that ink is directly attached to the Pencil.

Priorities, in order:

1. Input latency
2. Drawing frame rate
3. No dropped strokes
4. Reliable autosave
5. Fast pan/zoom
6. Recognition latency
7. Synchronization speed

Recognition can take hundreds of milliseconds or longer.

Ink rendering cannot.

Background work should therefore be isolated using workers wherever appropriate.

---

# 30. MVP

The MVP should be deliberately narrower than the eventual vision.

## MVP must have

- web application
- installable/offline capability
- infinite canvas
- fixed A4 canvas
- Apple Pencil/stylus drawing
- pressure-sensitive pen where browser APIs permit
- pan and zoom
- pen/highlighter/eraser
- lasso/rectangle selection
- undo/redo
- configurable grid/background
- local autosave
- folders/notebooks
- handwriting recognition
- searchable recognized handwriting
- original ink + recognized-text representation
- manual "Clean Up"
- basic automatic cleanup
- Excalidraw-style text rendering
- rectangle/circle/line/arrow recognition
- smart arrow connections
- Markdown export

## Explicitly not MVP

- multiplayer
- advanced layer system
- digital painting tools
- complex PDF annotation
- AI-generated notes during writing
- full mathematical understanding
- automatic concept maps
- advanced diagram understanding
- collaborative comments
- presentation features

Keeping these outside the MVP protects the application's most important feature:

**exceptionally fast Pencil note-taking.**

---

# 31. Phase 2

Once the core notebook experience is excellent:

### Semantic recognition

Understand:

- headings
- lists
- equations
- diagrams
- relationships
- definitions
- examples
- questions

### Knowledge layer

Build relationships between concepts across notebooks.

### AI

Introduce:

- Ask My Notes
- lecture summaries
- study guides
- flashcards
- concept explanations
- related-note discovery
- automatic linking suggestions

The semantic object model established in Phase 1 should make these features possible without redesigning the storage format.

---

# 32. Product Principles

### 1. Pencil first

The fastest action should always be putting Pencil to screen and writing.

### 2. Never destroy ink

Recognition augments handwriting rather than replacing the source data.

### 3. Machine readable by default

Handwritten content should quietly become searchable and structured.

### 4. Offline means offline

A lecture cannot depend on Wi-Fi.

### 5. Spatial first, linear second

The canvas is the canonical representation. Markdown is a derived representation.

### 6. Recognition must not interrupt thought

No modal OCR workflow while taking notes.

### 7. Clean, not sterile

Recognition improves handwriting and shapes while retaining an Excalidraw-like personality.

### 8. AI is downstream

First build an excellent notebook and semantic data model. Then let AI operate on that structure.

---

# 33. Core Technical Principle

The most important architectural separation is:

```text
INPUT
Apple Pencil / Keyboard / Touch
              ↓

RAW CONTENT
Ink / Text / Images
              ↓

SEMANTIC MODEL
Words / Shapes / Connections / Concepts
              ↓

PRESENTATION
Canvas / Excalidraw-style visuals
              ↓

INTELLIGENCE
Search / Markdown / Links / AI
```

The visible canvas should therefore **not be the database**.

It is one visual projection of a richer underlying semantic document.

That distinction is what separates this product from a conventional drawing application with OCR added afterward.