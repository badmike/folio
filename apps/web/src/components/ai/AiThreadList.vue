<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AI_DOCK_KEY } from '../../ai/dock'
import type { ThreadSummary } from '../../ai/protocol'
import { timeAgo } from '../../composables'
import { confirmDialog, promptDialog } from '../../services/dialogs'
import { toastError } from '../../services/toast'
import Icon from '../Icon.vue'
import Menu, { type MenuItem } from '../Menu.vue'

const dock = inject(AI_DOCK_KEY)!
const pinned = dock.pinned
const active = computed(() => dock.threads.value.filter((t) => !t.pinKey))
const settled = computed(() => dock.settled.value)
const currentId = computed(() => dock.session.value.id)
const searching = computed(() => !!dock.search.value.trim())

let timer: ReturnType<typeof setTimeout> | undefined
const load = () => dock.refreshThreads().catch((e) => toastError(e instanceof Error ? e.message : 'Could not load the threads.'))
onMounted(load)
onBeforeUnmount(() => { clearTimeout(timer); clearTimeout(holdTimer) })
watch(dock.search, () => {
  clearTimeout(timer)
  timer = setTimeout(load, 250)
})
function toggleSettled() {
  dock.showSettled.value = !dock.showSettled.value
  if (dock.showSettled.value) void load()
}

async function act(fn: () => Promise<void>) {
  try { await fn() } catch (e) { toastError(e instanceof Error ? e.message : 'Something went wrong.') }
}
function menu(t: ThreadSummary): MenuItem[] {
  return [
    { label: 'Rename…', icon: 'edit', action: () => void act(async () => {
      const title = await promptDialog({ title: 'Rename thread', label: 'Title', value: t.title })
      if (title?.trim() && title.trim() !== t.title) await dock.rename(t, title.trim())
    }) },
    { label: t.pinKey ? 'Unpin' : 'Pin', icon: t.pinKey ? 'pin-off' : 'pin', action: () => void act(() => dock.togglePin(t)) },
    { label: t.settledAt ? 'Move back to active' : 'Settle', icon: 'archive', action: () => void act(() => dock.toggleSettled(t)) },
    { divider: true },
    { label: 'Delete…', icon: 'trash', danger: true, action: () => void act(async () => {
      const ok = await confirmDialog({
        title: 'Delete thread?', message: `“${t.title || 'New thread'}” is deleted. Edits the AI made in your notebook stay.`, confirmLabel: 'Delete', danger: true,
      })
      if (ok) await dock.remove(t)
    }) },
  ]
}
function open(t: ThreadSummary) {
  if (!justDragged) void act(() => dock.openThread(t.id))
}

/**
 * Reordering pinned threads: a mouse drags after a few pixels, touch and pen after a short hold so that
 * scrolling the list still works. The drop position is the number of other pinned threads above the pointer.
 */
const HOLD_MS = 280
const rows = new Map<string, HTMLElement>()
const drag = ref<{ id: string; dy: number; to: number } | null>(null)
let press: { thread: ThreadSummary; x: number; y: number; touch: boolean; row: HTMLElement; pointerId: number } | null = null
let holdTimer: ReturnType<typeof setTimeout> | undefined
/** True until the click that ends a drag has passed. */
let justDragged = false

function pressRow(e: PointerEvent, thread: ThreadSummary) {
  if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || (e.target as HTMLElement).closest('.more')) return
  press = { thread, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse', row: e.currentTarget as HTMLElement, pointerId: e.pointerId }
  if (press.touch) holdTimer = setTimeout(startDrag, HOLD_MS)
}
function startDrag() {
  if (!press) return
  press.row.setPointerCapture(press.pointerId)
  drag.value = { id: press.thread.id, dy: 0, to: pinned.value.findIndex((t) => t.id === press!.thread.id) }
}
function dropIndex(y: number, id: string): number {
  const i = pinned.value.filter((t) => t.id !== id).findIndex((t) => {
    const r = rows.get(t.id)?.getBoundingClientRect()
    return !!r && y < r.top + r.height / 2
  })
  return i < 0 ? pinned.value.length - 1 : i
}
function moveRow(e: PointerEvent) {
  if (!press) return
  if (!drag.value) {
    const far = Math.hypot(e.clientX - press.x, e.clientY - press.y)
    if (press.touch && far > 8) endPress()
    else if (!press.touch && far > 4) startDrag()
    return
  }
  drag.value = { id: press.thread.id, dy: e.clientY - press.y, to: dropIndex(e.clientY, press.thread.id) }
}
function releaseRow() {
  const d = drag.value
  const thread = press?.thread
  endPress()
  if (!d || !thread) return
  justDragged = true
  setTimeout(() => { justDragged = false })
  if (d.to !== pinned.value.findIndex((t) => t.id === d.id)) void act(() => dock.movePin(thread, d.to))
}
function endPress() {
  clearTimeout(holdTimer)
  press = null
  drag.value = null
}
function stopScroll(e: TouchEvent) {
  if (drag.value) e.preventDefault()
}
const rowRef = (id: string) => (el: unknown) => { if (el instanceof HTMLElement) rows.set(id, el); else rows.delete(id) }
/** Where the dragged thread would land: above this row, or below it when it is the last one. */
function dropMark(t: ThreadSummary): 'above' | 'below' | undefined {
  const d = drag.value
  if (!d || d.id === t.id) return undefined
  const others = pinned.value.filter((x) => x.id !== d.id)
  if (others[d.to]?.id === t.id) return 'above'
  return d.to === others.length && others[d.to - 1]?.id === t.id ? 'below' : undefined
}
const statusLabel: Partial<Record<ThreadSummary['status'], string>> = {
  running: 'Running', awaiting_tools: 'Interrupted', needs_input: 'Needs your answer', failed: 'Failed',
}
const groups = computed(() => [
  { key: 'pinned', title: 'Pinned', list: pinned.value },
  { key: 'active', title: pinned.value.length ? 'Threads' : '', list: active.value },
])
</script>

<template>
  <div class="list" data-testid="ai-thread-list">
    <div class="top">
      <label class="search">
        <Icon name="search" :size="15" />
        <input v-model="dock.search.value" type="search" placeholder="Search threads" aria-label="Search threads" data-testid="ai-thread-search" />
      </label>
      <button class="btn small new" data-testid="ai-new-thread" @click="dock.newThread()"><Icon name="plus" :size="15" /> New thread</button>
    </div>

    <div class="scroll">
      <template v-for="g in groups" :key="g.key">
        <section v-if="g.list.length">
          <h4 v-if="g.title">{{ g.title }}</h4>
          <div v-for="t in g.list" :key="t.id" :ref="g.key === 'pinned' ? rowRef(t.id) : undefined" class="row"
               :class="[{ current: t.id === currentId, pinned: t.pinKey, dragging: drag?.id === t.id }, t.pinKey && dropMark(t)]"
               :style="drag?.id === t.id ? { transform: `translateY(${drag.dy}px)` } : undefined" data-testid="ai-thread-row"
               @pointerdown="t.pinKey && pressRow($event, t)" @pointermove="moveRow" @pointerup="releaseRow" @pointercancel="endPress"
               @touchmove="stopScroll" @contextmenu="drag && $event.preventDefault()">
            <button class="open" @click="open(t)">
              <span class="title"><Icon v-if="t.pinKey" name="pin" :size="12" />{{ t.title || 'New thread' }}</span>
              <span class="sub">
                <span v-if="statusLabel[t.status]" class="status" :class="t.status">{{ statusLabel[t.status] }}</span>
                {{ timeAgo(t.lastActivityAt) }}
              </span>
            </button>
            <Menu :items="menu(t)" align="right">
              <template #default="{ open: isOpen }">
                <button class="icon-btn more" :class="{ active: isOpen }" aria-label="Thread actions" data-testid="ai-thread-menu"><Icon name="more" :size="16" /></button>
              </template>
            </Menu>
          </div>
        </section>
      </template>
      <p v-if="!pinned.length && !active.length && !dock.listLoading.value" class="note">
        {{ searching ? 'No threads match.' : 'No threads yet. Start one below.' }}
      </p>

      <section class="shelf">
        <button class="shelf-head" :aria-expanded="dock.showSettled.value || searching" data-testid="ai-settled-toggle" @click="toggleSettled">
          <Icon :name="dock.showSettled.value || searching ? 'down' : 'right'" :size="14" /> Settled
        </button>
        <template v-if="dock.showSettled.value || searching">
          <div v-for="t in settled" :key="t.id" class="row" :class="{ current: t.id === currentId }" data-testid="ai-thread-row">
            <button class="open" @click="open(t)">
              <span class="title">{{ t.title || 'New thread' }}</span>
              <span class="sub">{{ timeAgo(t.lastActivityAt) }}</span>
            </button>
            <Menu :items="menu(t)" align="right">
              <template #default="{ open: isOpen }">
                <button class="icon-btn more" :class="{ active: isOpen }" aria-label="Thread actions"><Icon name="more" :size="16" /></button>
              </template>
            </Menu>
          </div>
          <p v-if="!settled.length" class="note">Threads idle for 3 days settle here.</p>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.list { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.top { display: flex; gap: 6px; padding: 10px 10px 6px; }
.search {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 8px; cursor: text;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); color: var(--muted);
}
.search:focus-within { border-color: var(--accent); }
.search input { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; font-size: 13.5px; color: var(--text-strong); }
.search input::-webkit-search-cancel-button { display: none; }
.new { min-height: 34px; padding: 0 10px; font-size: 13.5px; gap: 4px; }
.scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 0 6px 10px; }
section { margin-top: 6px; }
h4 { margin: 8px 8px 4px; font-size: 12px; font-weight: 600; color: var(--muted); }
.row { display: flex; align-items: center; border-radius: var(--radius); }
.row:hover { background: var(--surface-2); }
.row.current { background: var(--accent-soft); }
.row.pinned { position: relative; user-select: none; -webkit-touch-callout: none; }
.row.dragging { z-index: 1; background: var(--surface-2); box-shadow: var(--shadow-sm); cursor: grabbing; }
.row.above::before, .row.below::after { content: ''; position: absolute; left: 8px; right: 8px; height: 2px; border-radius: 1px; background: var(--accent); }
.row.above::before { top: -1px; }
.row.below::after { bottom: -1px; }
.open { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; padding: 6px 8px; border: 0; background: none; text-align: left; }
.title { display: flex; align-items: center; gap: 5px; font-size: 13.5px; color: var(--text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.title :deep(svg) { flex: none; color: var(--muted); }
.sub { font-size: 12px; color: var(--muted); }
.status { margin-right: 4px; font-weight: 600; }
.status.running { color: var(--accent-strong); }
.status.awaiting_tools, .status.needs_input { color: var(--warn); }
.status.failed { color: var(--danger); }
.more { width: 30px; height: 30px; margin-right: 2px; opacity: 0; }
.row:hover .more, .more.active, .more:focus-visible { opacity: 1; }
@media (pointer: coarse) { .more { opacity: 1; } }
.shelf { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 4px; }
.shelf-head { display: flex; align-items: center; gap: 4px; width: 100%; padding: 6px 8px; border: 0; background: none; font-size: 12.5px; font-weight: 600; color: var(--muted); text-align: left; }
.shelf-head:hover { color: var(--text-strong); }
.note { margin: 8px 10px; font-size: 13px; color: var(--muted); }
</style>
