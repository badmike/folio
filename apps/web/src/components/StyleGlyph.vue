<script setup lang="ts">
import { computed } from 'vue'

/**
 * Small preview glyphs for the properties panel (stroke widths, line styles, sloppiness,
 * arrow types, arrowheads, fonts, alignment, layers). Unlike Icon.vue these need per-glyph
 * stroke widths, dashes and fills.
 */
interface Part { d?: string; sw?: number; dash?: string; fill?: boolean; circle?: [number, number, number] }
const props = withDefaults(defineProps<{ name: string; size?: number; flip?: boolean }>(), { size: 22, flip: false })

const G: Record<string, Part[]> = {
  'w-0': [{ d: 'M4 12h16', sw: 1.5 }],
  'w-1': [{ d: 'M4 12h16', sw: 3.2 }],
  'w-2': [{ d: 'M4 12h16', sw: 5.5 }],
  'ls-solid': [{ d: 'M4 12h16', sw: 2 }],
  'ls-dashed': [{ d: 'M4 12h16', sw: 2, dash: '4 3.5' }],
  'ls-dotted': [{ d: 'M4 12h16', sw: 2.6, dash: '0.1 4.6' }],
  'rough-0': [{ d: 'M4 16L20 8', sw: 1.8 }],
  'rough-1': [{ d: 'M4 16c3-5 5 2 8-1s5-3 8-6', sw: 1.8 }],
  'rough-2': [{ d: 'M4 16c1-7 3 4 5-1s2 3 5-2 3 1 6-4', sw: 2.2 }, { d: 'M4 17c3-3 8-1 16-8', sw: 1.2 }],
  'fill-hachure': [{ d: 'M5 5h14v14H5z', sw: 1.6 }, { d: 'M5 12L12 5|M5 19L19 5|M12 19l7-7', sw: 1.6 }],
  'fill-cross': [{ d: 'M5 5h14v14H5z', sw: 1.6 }, { d: 'M5 12L12 5|M5 19L19 5|M12 19l7-7|M12 5l7 7|M5 5l14 14|M5 12l7 7', sw: 1.3 }],
  'fill-solid': [{ d: 'M5 5h14v14H5z', sw: 1.6, fill: true }],
  'at-straight': [{ d: 'M6 18L18 6|M10 6h8v8', sw: 1.9 }],
  'at-curved': [{ d: 'M6 18c0-8 5-11 11-11|M13 4l4 3-3 4', sw: 1.9 }],
  'at-elbow': [{ d: 'M6 18h6V8h6|M15 5l3 3-3 3', sw: 1.9 }],
  'head-none': [{ d: 'M4 12h16', sw: 1.9 }, { d: 'M15 9l4 6|M19 9l-4 6', sw: 1.4 }],
  'head-arrow': [{ d: 'M4 12h16|M14 6l6 6-6 6', sw: 1.9 }],
  'head-triangle': [{ d: 'M4 12h11', sw: 1.9 }, { d: 'M14 6l7 6-7 6z', sw: 1.6, fill: true }],
  'head-triangle-outline': [{ d: 'M4 12h10', sw: 1.9 }, { d: 'M14 6l7 6-7 6z', sw: 1.6 }],
  'head-dot-outline': [{ d: 'M4 12h9.4', sw: 1.9 }, { circle: [17, 12, 3.6], sw: 1.6 }],
  'head-diamond': [{ d: 'M4 12h8', sw: 1.9 }, { d: 'M12 12l4.5-4.5L21 12l-4.5 4.5z', sw: 1.6, fill: true }],
  'head-diamond-outline': [{ d: 'M4 12h8', sw: 1.9 }, { d: 'M12 12l4.5-4.5L21 12l-4.5 4.5z', sw: 1.6 }],
  'head-crowfoot-one': [{ d: 'M4 12h16|M16 6v12', sw: 1.9 }],
  'head-crowfoot-many': [{ d: 'M4 12h16|M13 12l7-6|M13 12l7 6', sw: 1.9 }],
  'head-crowfoot-one-or-many': [{ d: 'M4 12h16|M14 12l6-6|M14 12l6 6|M10 6v12', sw: 1.9 }],
  'head-dot': [{ d: 'M4 12h12', sw: 1.9 }, { circle: [17.5, 12, 3.4], sw: 1.6, fill: true }],
  'head-bar': [{ d: 'M4 12h16|M20 6v12', sw: 1.9 }],
  'ff-hand': [{ d: 'M4 20h4L19 9l-4-4L4 16z', sw: 1.8 }],
  'ff-sans': [{ d: 'M5 19L12 5l7 14|M8 14h8', sw: 2 }],
  'ff-mono': [{ d: 'M9 8l-5 4 5 4|M15 8l5 4-5 4', sw: 2 }],
  'ta-left': [{ d: 'M4 6h16|M4 10h10|M4 14h16|M4 18h10', sw: 1.9 }],
  'ta-center': [{ d: 'M4 6h16|M7 10h10|M4 14h16|M7 18h10', sw: 1.9 }],
  'ta-right': [{ d: 'M4 6h16|M10 10h10|M4 14h16|M10 18h10', sw: 1.9 }],
  'ly-back': [{ d: 'M12 4v11|M7 10l5 5 5-5|M5 20h14', sw: 1.9 }],
  'ly-backward': [{ d: 'M12 5v13|M6 12l6 6 6-6', sw: 1.9 }],
  'ly-forward': [{ d: 'M12 19V6|M6 12l6-6 6 6', sw: 1.9 }],
  'ly-front': [{ d: 'M12 20V9|M7 14l5-5 5 5|M5 4h14', sw: 1.9 }],
  'cap-flat': [{ d: 'M5 8h14v8H5z', sw: 1.5, fill: true }],
  'cap-round': [{ d: 'M9 8h6a4 4 0 010 8H9a4 4 0 010-8z', sw: 1.5, fill: true }],
  'cap-slanted': [{ d: 'M7 8h13l-3 8H4z', sw: 1.5, fill: true }],
  'cap-curvy': [{ d: 'M3 12c4-5 8-5 9-4s5 1 9 4c-4 5-8 5-9 4s-5-1-9-4z', sw: 1.5, fill: true }],
  'corner-sharp': [{ d: 'M5 19V5h14', sw: 2 }],
  'corner-round': [{ d: 'M5 19v-8a6 6 0 016-6h8', sw: 2 }],
  'blur-pixelate': [{ d: 'M4 4h5v5H4z|M14 4h6v6h-6z|M9 9h5v5H9z|M4 14h5v6H4z|M14 14h6v6h-6z', sw: 1.4, fill: true }],
  'blur-gaussian': [{ circle: [12, 12, 7], sw: 0, fill: true }, { circle: [12, 12, 4], sw: 3 }],
}
const parts = computed(() => (G[props.name] ?? []).flatMap((p) => (p.d ? p.d.split('|').map((d) => ({ ...p, d })) : [p])))
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"
       stroke-linejoin="round" aria-hidden="true" focusable="false" :style="flip ? 'transform: scaleX(-1)' : undefined">
    <template v-for="(p, i) in parts" :key="i">
      <circle v-if="p.circle" :cx="p.circle[0]" :cy="p.circle[1]" :r="p.circle[2]" :stroke-width="p.sw" :fill="p.fill ? 'currentColor' : 'none'" />
      <path v-else :d="p.d" :stroke-width="p.sw" :stroke-dasharray="p.dash" :fill="p.fill ? 'currentColor' : 'none'" :fill-opacity="p.fill ? 0.9 : 1" />
    </template>
  </svg>
</template>
