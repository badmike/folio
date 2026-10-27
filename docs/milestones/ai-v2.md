# AI V2: chat dock with notebook tools

V1 was a sheet with five one-shot presets and "ask my notes". The result was inserted as one text object. V2 replaces it with a chat dock: threads per notebook, streaming, and tools that let the AI read, draw, write and change the open notebook (and others, with approval).

Settled on 2026-10-27 in a grilling session with Mike. Reference implementations: T3 Code (`~/Development/tests/t3code`, thread and composer UX) and b10cks CMS (`~/Development/products/b10cks/cms`, `docs/concepts/native-ai-integration.md`, server loop and budgets).

## Contract

- `apps/web/src/ai/protocol.ts`: REST and SSE shapes. The server mirrors them with serde.
- `apps/web/src/ai/host.ts`: the seam between the tool executors and the app.
- `apps/server/tools/folio-tools.json`: tool names, descriptions and JSON schemas (server-owned, embedded with `include_str!`).
- `apps/server/tools/tool-guide.md`: how to use the tools well, appended to the system prompt.

Change a contract file only together with every side that uses it.

## Decisions

### Architecture

1. **Server steps, client tools.** The server owns the system prompt, tool schemas, API key, budget and history. It streams one model step per request over SSE. The browser owns the Loro document, so it executes every tool call and posts the results, which starts the next step.
2. **Threads in server SQLite**, scoped to (user, notebook). `notebook_id` is null for library threads, which use the cross-notebook tools.
3. **Transcript as items.** A thread is turns plus items (`user`, `assistant`, `tool_call`, `tool_result`). The client derives every timeline row from them, so new tools need no schema change. The transcript is stored as text and replayed exactly.
4. **Live edits with turn checkpoints.** Edits apply immediately and glow briefly. Each turn is one undo step in the editor. Each tool result stores its `effects` (ops plus inverse).
5. **Revert to this message** undoes the AI's ops of that turn and every later one, newest first. Objects the user changed since the AI touched them are skipped and listed. Then the conversation rewinds to that message, so it can be edited and resent.
6. **Approvals only for** deleting a page and writing to another notebook ("Allow for this thread"). They show in the composer slot, T3 style.
7. **Interrupted turns.** Only the device that started a turn runs its tools. If the tab closes mid-turn, the turn stays `awaiting_tools`. That device shows "Continue", which answers the lost calls with an "interrupted, re-read" error and runs the next step. Other devices show the turn read-only.
8. **Steering.** A message sent while a turn runs is shown as queued and goes into the next step request.

### Tools and perception

9. **Typed tools that follow the `Operation` model**, plus `draw_diagram(nodes, edges, layout)`, which computes positions itself (layered, tree, grid, radial). The layout is written by hand, with no new dependency.
10. **Ink:** the AI reads it through recognitions and may move, restyle or delete it. It never creates ink. AI text uses the theme's handwritten font.
11. **Perception:** each step carries the semantic outline of the current page with object ids and bounds. `read_objects` gives detail, and `look(region)` renders a PNG for vision on unresolved drawings.
12. **`ask_user`** pauses the turn and shows 2 to 4 options plus free text in the composer slot. A step answering only `ask_user` does not count against the step cap.
13. **Provenance is transient.** The doc schema doesn't change. New edits glow briefly, and each tool row in the chat zooms to and highlights its objects, using the stored effects.
14. **Write scope:** objects on any page of the notebook; adding, updating and deleting pages; notebook title, tags and theme; other notebooks (with approval).

### UI

15. **Dock.** On wide screens a right dock pushes the canvas, resizable from 340 to 640px with the width remembered. Below 1100px, and on iPad portrait, it becomes an overlay sheet. Cmd+J toggles it. The thread list is a view inside the dock.
16. **Composer:** automatic page and selection chips (removable), `@` mentions of pages, frames and notebooks, image attachments (paste, drop or pick, through `/assets`), a preset picker, the remaining credit, and Stop. Enter doesn't send on touch screens, so there is a send button beside Stop.
17. **Thread lifecycle (T3 Code):** auto title by a cheap model after the first turn (unless renamed), pin (fractional keys, synced), settle (manual, and automatically after 3 days idle), search over titles and message text, delete (never reverts edits). Failed turns offer "Retry".
18. **Entry points:**
    - **Dock:** button in the HUD actions and Cmd+J.
    - **"Ask AI" on the selection and lasso toolbar:** opens the dock with a selection chip and the composer focused.
    - **Cmd+K palette:** a minimal, general palette for jumping to pages and notebooks and running menu commands. "Ask AI: …" is the fallback row, and in the library it starts a library thread.
    - **Canvas prompt note:** recognized handwriting starting with `@ai` gets a small "Run" pill. Tapping it sends the note plus nearby objects. The ink stays, gets a done badge, and links to its thread. Nothing runs without a tap.
19. **V1 presets become slash commands and starter chips**: summarize, lecture, outline, flashcards, questions. `/ai/summarize`, `/ai/ask` and `AiPanel.vue` are removed. `/ai/recognize` stays.

### Models and cost

20. **Presets** come from the server config as OpenRouter slugs: Fast is Haiku 5.5, Smart is Sonnet 5.5 and the default, Deep is Opus 5.5. A cheap model writes the titles.
21. **Daily credit** per user in USD (`FOLIO_AI_DAILY_CREDIT_USD`, default 1.00), from tokens × preset price, including cache reads. Per-turn caps are 25 steps and 2M tokens. Hitting a cap ends the turn as `partial` and keeps its edits. A provider call with an ambiguous outcome is never retried automatically.
22. **Prompt order** puts the stable parts first so the cache hits: base instructions, tool guide, user instructions, notebook instructions, then history, then this step's environment. Use `cache_control` breakpoints for Anthropic models through OpenRouter. Notebook content goes inside a random-suffix fence and is treated as untrusted data.
23. **History** replays the non-reverted turns up to a token budget, dropping old tool results first. There is no compaction in V2.
24. **Custom instructions** come at two levels, per user and per (user, notebook), both stored on the server and capped at 4000 characters.

### Out of scope

Background or scheduled runs, forking threads, a usage page, `/compact`, embeddings, AI-generated ink, voice and pencil input in the composer, and i18n (the UI is English only).

## Milestones

The product slices, in the order they become usable.

- **M1: dock and conversation.** Dock, thread list and lifecycle, streaming, presets and credit, read tools, slash commands. V1 removed.
- **M2: editing.** Write tools, effects, the turn undo step, revert to message, approvals, interrupted and continue, steering.
- **M3: richer perception.** `draw_diagram` layout, `look`, image attachments, `ask_user`.
- **M4: entry points.** Selection "Ask AI", Cmd+K palette, `@ai` prompt note, custom instructions in Settings.

## Implementation waves

The work is built in parallel by area, not by milestone. Each agent owns its files and doesn't edit the others'. Contract files change only through the integrator.

### Wave 1

| Stream | Owns | Delivers |
| --- | --- | --- |
| Server | `apps/server/**` except `apps/server/tools/` | Migration, the step loop and SSE, streaming OpenRouter with tools, threads API, auto title, credit and caps, instructions API, removal of summarize and ask |
| Tools | `apps/web/src/ai/tools/**`, `apps/server/tools/**`, `packages/document`, `packages/editor` (minimal additions only) | All 20 tool executors, `draw_diagram` layout, revert with skip-touched, context builder, schemas and tool guide |
| Dock | `apps/web/src/ai/` except `tools/`, `apps/web/src/components/ai/**`, wiring in `NotebookScreen.vue`, `notebook.ts`, `services/ai.ts` | API client and SSE parser, turn loop driver, ToolHost implementation, dock, thread list, timeline, composer, approval and ask_user slots, slash commands, V1 UI removed |

### Wave 2

| Stream | Delivers |
| --- | --- |
| Entry points | Selection "Ask AI", Cmd+K palette, `@ai` prompt note pill, instructions in Settings, library dock |
| Integration | Run end to end against the server with a real model, fix seams, add the Playwright dock test, update the docs |

## Status

- 2026-10-27, wave 2 integration (`ai-v2/e2e`): ran end to end against OpenRouter, mostly on Fast with two Smart turns. Every M1 to M3 flow works: questions, shapes and text, `draw_diagram`, edits and moves, `look`, image attachments, `ask_user`, the `delete_page` approval, steering, stop, revert with skipped user edits, Continue after a reload, the thread list, slash commands and the credit display. The prompt cache hits from the second step on. `apps/web/e2e/ai-dock.spec.ts` covers the dock against a scripted server.
