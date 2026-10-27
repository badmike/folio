<script setup lang="ts">
import { themeLineColor, themePaper, type CanvasObject, type Page, type ResolvedTheme, type ShapeStyle } from '@folio/document'
import { renderToCanvas } from '@folio/renderer'
import { onMounted, ref, watch } from 'vue'
import { whenFontsReady } from '../services/fonts'

/** A small sample sheet drawn by the real renderer in a theme: heading, filled box, arrow, outlined box. */
const props = withDefaults(defineProps<{ theme: ResolvedTheme; dark?: boolean }>(), { dark: false })

const W = 320
const H = 180
const canvas = ref<HTMLCanvasElement | null>(null)

const T = (x: number, y: number) => ({ x, y, rotation: 0, scaleX: 1, scaleY: 1 })
const style = (seed: number, o: Partial<ShapeStyle> = {}): ShapeStyle => ({ strokeColor: '#1e1e1e', strokeWidth: 2, opacity: 1, roughness: 1, seed, ...o })
const base = (id: string, z: number) => ({ id, z, createdAt: 0, updatedAt: 0 })
const OBJECTS: CanvasObject[] = [
  { ...base('h', 1), type: 'text', transform: T(18, 14), text: 'Lecture', fontSize: 30, fontFamily: 'hand', color: '#1e1e1e' },
  { ...base('u', 2), type: 'shape', kind: 'line', transform: T(18, 56), width: 130, height: 0, style: style(3) },
  { ...base('a', 3), type: 'shape', kind: 'rectangle', transform: T(18, 82), width: 120, height: 66, style: style(7, { fillColor: '#ffec99', fillStyle: 'hachure' }), label: 'Idea' },
  { ...base('b', 4), type: 'arrow', transform: T(0, 0), start: { x: 148, y: 116 }, end: { x: 186, y: 114 }, style: style(5), startHead: 'none', endHead: 'arrow' },
  { ...base('c', 5), type: 'shape', kind: 'rectangle', transform: T(194, 82), width: 108, height: 66, style: style(11), label: 'Notes' },
]
const byId = new Map(OBJECTS.map((o) => [o.id, o]))

function draw() {
  const c = canvas.value
  if (!c?.getContext('2d')) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  c.width = W * dpr
  c.height = H * dpr
  const color = themePaper(props.theme, props.dark)
  const page: Page = {
    id: 'preview', title: '', kind: 'infinite', order: 0, createdAt: 0, updatedAt: 0,
    background: { pattern: 'blank', spacing: 32, opacity: 0.5, color, lineColor: themeLineColor(props.theme, color) },
  }
  renderToCanvas({ page, objects: OBJECTS, resolve: (id) => byId.get(id), theme: props.theme }, { x: 0, y: 0, zoom: dpr }, c)
}

onMounted(() => {
  draw()
  void whenFontsReady().then(draw)
})
watch(() => [props.theme.key, props.dark], draw)
</script>

<template>
  <canvas ref="canvas" class="theme-preview" role="img" :aria-label="`${theme.id} preview`" />
</template>

<style scoped>
.theme-preview { display: block; width: 100%; aspect-ratio: 16 / 9; border-radius: 6px; }
</style>
