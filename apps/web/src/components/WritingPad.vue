<script setup lang="ts">
import { createId, type InkStroke, type StrokeStyle } from '@folio/document'
import { buildInkStroke } from '@folio/editor'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/** A small pen surface that records ink strokes (CSS px coordinates), e.g. for handwriting calibration. */
const strokes = defineModel<InkStroke[]>({ required: true })
/** Number of guide lines to write on. */
const props = withDefaults(defineProps<{ rows?: number }>(), { rows: 1 })

const STYLE: StrokeStyle = { tool: 'pen', color: '#000', width: 2.5, opacity: 1, pressureSensitive: false }

const canvas = ref<HTMLCanvasElement>()
let ctx: CanvasRenderingContext2D | null = null
let current: { id: number; flat: number[]; t0: number; startedAt: number; type: InkStroke['pointerType'] } | null = null
/** Once a pen was used, touches are palms. */
let penSeen = false
let observer: ResizeObserver | undefined
/** Strokes emitted but not yet echoed back through the model (several can end in one tick). */
let pending: InkStroke[] | null = null

function setup() {
  const c = canvas.value
  if (!c) return
  const dpr = window.devicePixelRatio || 1
  c.width = Math.round(c.clientWidth * dpr)
  c.height = Math.round(c.clientHeight * dpr)
  ctx = c.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  redraw()
}

function redraw() {
  const c = canvas.value
  if (!ctx || !c) return
  ctx.clearRect(0, 0, c.clientWidth, c.clientHeight)
  const style = getComputedStyle(c)
  ctx.strokeStyle = style.borderColor
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let row = 0; row < props.rows; row++) {
    const y = Math.round(((row + 0.68) / props.rows) * c.clientHeight) + 0.5
    ctx.moveTo(16, y)
    ctx.lineTo(c.clientWidth - 16, y)
  }
  ctx.stroke()
  ctx.strokeStyle = style.color
  ctx.lineWidth = STYLE.width
  ctx.lineCap = ctx.lineJoin = 'round'
  for (const s of strokes.value) {
    const p = s.points
    ctx.beginPath()
    ctx.moveTo(s.transform.x + p[0], s.transform.y + p[1])
    for (let i = 6; i < p.length; i += 6) ctx.lineTo(s.transform.x + p[i], s.transform.y + p[i + 1])
    if (p.length === 6) ctx.lineTo(s.transform.x + p[0] + 0.1, s.transform.y + p[1])
    ctx.stroke()
  }
}

function local(e: PointerEvent): [number, number] {
  const r = canvas.value!.getBoundingClientRect()
  return [e.clientX - r.left, e.clientY - r.top]
}

function onDown(e: PointerEvent) {
  if (e.pointerType === 'pen') penSeen = true
  else if (e.pointerType === 'touch' && penSeen) return
  e.preventDefault()
  if (current) {
    // A resting palm never interrupts the pen. A pen replaces a palm that landed first, and a
    // stroke whose end Safari never reported is kept before the next one starts.
    if (e.pointerType === 'touch') return
    if (current.type === 'touch') { current = null; redraw() } else finish()
  }
  canvas.value!.setPointerCapture(e.pointerId)
  const type = e.pointerType === 'pen' || e.pointerType === 'touch' ? e.pointerType : 'mouse'
  current = { id: e.pointerId, flat: [], t0: e.timeStamp, startedAt: Date.now(), type }
  add(e)
}

function add(e: PointerEvent) {
  if (!current || !ctx) return
  const [x, y] = local(e)
  const f = current.flat
  if (f.length) {
    ctx.beginPath()
    ctx.moveTo(f[f.length - 6], f[f.length - 5])
    ctx.lineTo(x, y)
    ctx.stroke()
  }
  f.push(x, y, e.pressure, e.tiltX, e.tiltY, Math.max(0, e.timeStamp - current.t0))
}

function onMove(e: PointerEvent) {
  if (e.pointerId !== current?.id) return
  const list = e.getCoalescedEvents?.() ?? []
  for (const c of list.length ? list : [e]) add(c)
}

function onUp(e: PointerEvent) {
  if (e.pointerId === current?.id) finish()
}

/** Commit the stroke being drawn. */
function finish() {
  const c = current
  current = null
  if (!c?.flat.length) return
  const base = pending ?? strokes.value
  pending = [...base, buildInkStroke(c.flat, { id: createId(), style: STYLE, pointerType: c.type, startedAt: c.startedAt, z: base.length })]
  strokes.value = pending
  void nextTick(() => { pending = null })
}

function onCancel(e: PointerEvent) {
  if (e.pointerId !== current?.id) return
  current = null
  redraw()
}

watch(strokes, redraw)
onMounted(() => {
  observer = new ResizeObserver(setup)
  observer.observe(canvas.value!)
  setup()
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <canvas ref="canvas" class="pad" data-testid="writing-pad"
    @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @lostpointercapture="onUp" @pointercancel="onCancel"
    @touchstart.prevent @contextmenu.prevent />
</template>

<style scoped>
.pad {
  display: block; width: 100%; height: 160px; touch-action: none; cursor: crosshair;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text-strong);
}
</style>
