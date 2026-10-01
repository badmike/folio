<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 22 })

/** 24x24 stroke icons (Lucide-style). Multiple subpaths separated by '|'. */
const ICONS: Record<string, string> = {
  back: 'M15 18l-6-6 6-6',
  select: 'M5 3l14 8-6.2 1.8L11 19z',
  lasso: 'M12 4c4.4 0 8 2 8 5s-3.6 5-8 5c-1 0-2-.1-3-.4L6 18l1-4.3C5.2 12.8 4 11.5 4 9c0-3 3.6-5 8-5z',
  pen: 'M12 20h9|M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
  highlighter: 'M9 11l-6 6v3h9l3-3|M22 12l-4.6 4.6a2 2 0 01-2.8 0l-5.2-5.2a2 2 0 010-2.8L14 4',
  eraser: 'M20 20H8L3.5 15.5a1.5 1.5 0 010-2.1l9.9-9.9a1.5 1.5 0 012.1 0l5 5a1.5 1.5 0 010 2.1L12 20',
  shape: 'M3 3h9v9H3z|M17 21a4 4 0 100-8 4 4 0 000 8z',
  rectangle: 'M4 5h16v14H4z',
  ellipse: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z',
  triangle: 'M12 4l9 16H3z',
  diamond: 'M12 3l9 9-9 9-9-9z',
  line: 'M5 19L19 5',
  arrow: 'M5 19L19 5|M9 5h10v10',
  text: 'M4 7V4h16v3|M9 20h6|M12 4v16',
  undo: 'M9 14L4 9l5-5|M4 9h10a6 6 0 010 12h-3',
  redo: 'M15 14l5-5-5-5|M20 9H10a6 6 0 000 12h3',
  plus: 'M12 5v14|M5 12h14',
  minus: 'M5 12h14',
  trash: 'M3 6h18|M8 6V4h8v2|M6 6l1 14h10l1-14',
  copy: 'M9 9h11v11H9z|M5 15V4h11',
  more: 'M5 12h.01|M12 12h.01|M19 12h.01',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14z|M21 21l-4.3-4.3',
  settings: 'M4 6h10|M18 6h2|M4 12h4|M12 12h8|M4 18h12|M20 18h0|M14 4v4|M8 10v4|M16 16v4',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  notebook: 'M6 3h9l4 4v14H6z|M14 3v5h5',
  download: 'M12 4v12|M7 11l5 5 5-5|M4 20h16',
  upload: 'M12 20V8|M7 13l5-5 5 5|M4 4h16',
  sparkles: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z|M19 16v4|M17 18h4',
  layers: 'M12 3l9 5-9 5-9-5z|M3 13l9 5 9-5',
  cleanup: 'M4 20L14 10|M14 10l3-6 3 6-3 3z|M5 4v4|M3 6h4',
  restore: 'M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8|M3 3v5h5',
  group: 'M4 4h8v8H4z|M12 12h8v8h-8z',
  ungroup: 'M4 4h6v6H4z|M14 14h6v6h-6z',
  front: 'M8 8h12v12H8z|M4 16V4h12',
  back_: 'M4 4h12v12H4z|M8 20h12V8',
  check: 'M5 13l4 4L19 7',
  x: 'M6 6l12 12|M18 6L6 18',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  right: 'M9 6l6 6-6 6',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8z|M4 21a8 8 0 0116 0',
  cloud: 'M7 18a5 5 0 010-10 6 6 0 0111.5 1.5A4.2 4.2 0 0117 18z',
  fit: 'M4 9V4h5|M15 4h5v5|M20 15v5h-5|M9 20H4v-5',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
  tag: 'M3 12V3h9l9 9-9 9z|M7.5 7.5h.01',
  move: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z|M12 11v6|M9 14l3-3 3 3',
  sort: 'M7 4v16|M3 16l4 4 4-4|M17 20V4|M13 8l4-4 4 4',
  doc: 'M6 3h9l4 4v14H6z|M9 13h7|M9 17h7',
  offline: 'M2 2l20 20|M8.5 16.4a5 5 0 017 0|M2 8.8a15 15 0 014.2-2.6|M10 5.1a15 15 0 0112 3.7|M5 12.9a10 10 0 015-2.7|M14 10.4a10 10 0 015 2.5',
  alert: 'M12 3l10 18H2z|M12 10v5|M12 18h.01',
  eyedropper: 'M14.5 5.5l4 4|M13 7l4 4-9 9H4v-4z|M16 4a2 2 0 013 3l-2 2-3-3z',
  zen: 'M12 3c5 3 7 8 0 18-7-10-5-15 0-18z|M12 21V10',
  menu: 'M4 7h16|M4 12h16|M4 17h16',
  sliders: 'M4 6h9|M17 6h3|M4 12h3|M11 12h9|M4 18h11|M19 18h1|M15 4v4|M7 10v4|M17 16v4',
  chevleft: 'M15 6l-6 6 6 6',
  hand: 'M8 13V5.5a1.5 1.5 0 013 0V12|M11 11V4.5a1.5 1.5 0 013 0V12|M14 12V6.5a1.5 1.5 0 013 0V13|M17 12.5a1.5 1.5 0 013 .5v3a6 6 0 01-6 6h-2a6 6 0 01-5-2.7L4.2 15a1.5 1.5 0 012.4-1.8L8 15',
  frame: 'M7 3v18|M17 3v18|M3 7h18|M3 17h18',
  blur: 'M4 4h5v5H4z|M9 9h5v5H9z|M14 14h6v6h-6z|M14 4h6v5h-6z|M4 14h5v6H4z',
  lock: 'M6 11V8a6 6 0 0112 0v3|M5 11h14v10H5z',
  unlock: 'M6 11V8a6 6 0 0111.5-2.4|M5 11h14v10H5z',
  grid: 'M4 4h16v16H4z|M4 10h16|M4 15h16|M10 4v16|M15 4v16',
  fullscreen: 'M4 9V4h5|M15 4h5v5|M20 15v5h-5|M9 20H4v-5',
  library: 'M4 4h5v16H4z|M11 4h5v16h-5z|M18 5l3 15-4 .8L14 5.8z',
  keyboard: 'M3 7h18v10H3z|M7 11h.01|M11 11h.01|M15 11h.01|M7 14h10',
  paste: 'M9 4h6v3H9z|M6 6h12v14H6z|M9 12h6|M9 15h4',
  compact: 'M4 6h16|M4 12h16|M4 18h16',
  'align-left': 'M4 3v18|M8 6h9v4H8z|M8 14h5v4H8z',
  'align-center-x': 'M12 3v18|M6 6h12v4H6z|M9 14h6v4H9z',
  'align-right': 'M20 3v18|M7 6h9v4H7z|M11 14h5v4h-5z',
  'align-top': 'M3 4h18|M6 8h4v9H6z|M14 8h4v5h-4z',
  'align-center-y': 'M3 12h18|M6 6h4v12H6z|M14 9h4v6h-4z',
  'align-bottom': 'M3 20h18|M6 7h4v9H6z|M14 11h4v5h-4z',
  'distribute-x': 'M3 4v16|M21 4v16|M8 8h3v8H8z|M14 8h3v8h-3z',
  'distribute-y': 'M4 3h16|M4 21h16|M8 8h8v3H8z|M8 14h8v3H8z',
}

const paths = computed(() => (ICONS[props.name] ?? '').split('|'))
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path v-for="(d, i) in paths" :key="i" :d="d" />
  </svg>
</template>
