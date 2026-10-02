<script setup lang="ts">
import Modal from './Modal.vue'

defineEmits<{ (e: 'close'): void }>()
const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const mod = mac ? '⌘' : 'Ctrl'
const alt = mac ? '⌥' : 'Alt'

/** Excalidraw key map plus folio's own tools (highlighter, blur). */
const GROUPS: { title: string; rows: [string, string][] }[] = [
  { title: 'Tools', rows: [
    ['Selection', 'V · 1'], ['Hand (pan)', 'H'], ['Rectangle', 'R · 2'], ['Diamond', 'D · 3'], ['Ellipse', 'O · 4'], ['Arrow', 'A · 5'],
    ['Line', 'L · 6'], ['Pen', 'P · 7'], ['Text', 'T · 8'], ['Eraser', 'E · 0'], ['Frame', 'F'], ['Highlighter', 'M'], ['Blur', 'X'],
    ['Keep tool active (lock)', 'Q'], ['Edit text / label', 'Enter'], ['Finish text', 'Esc · ' + mod + '+Enter'],
  ] },
  { title: 'View', rows: [
    ['Zoom in / out', mod + '+ + / ' + mod + '+ −'], ['Reset zoom', mod + '+0'], ['Zoom to fit', 'Shift+1'], ['Zoom to selection', 'Shift+2'],
    ['Pan', 'Space+drag · wheel'], ['Zen mode', alt + '+Z'], ['Presenter mode', alt + '+P'], ['Toggle grid', mod + "+'"], ['Lock notebook (view mode)', alt + '+R'],
    ['Search in notebook', mod + '+F'], ['Show hidden interface', 'Esc · Space'], ['This list', '?'],
  ] },
  { title: 'Editor', rows: [
    ['Undo / Redo', mod + '+Z · ' + mod + '+Shift+Z'], ['Cut / Copy / Paste', mod + '+X · ' + mod + '+C · ' + mod + '+V'],
    ['Select all', mod + '+A'], ['Delete', 'Delete'], ['Duplicate', mod + '+D · ' + alt + '+drag'], ['Multi-select', 'Shift+click'],
    ['Group / Ungroup', mod + '+G · ' + mod + '+Shift+G'], ['Nudge', 'Arrows · Shift+Arrows'],
    ['Bring forward / Send backward', mod + '+] · ' + mod + '+['], ['Bring to front / Send to back', mod + '+Shift+] · ' + mod + '+Shift+['],
    ['Align left / right', mod + '+Shift+← · ' + mod + '+Shift+→'], ['Align top / bottom', mod + '+Shift+↑ · ' + mod + '+Shift+↓'],
    ['Constrain (square, 45°)', 'Shift+drag'],
  ] },
]
</script>

<template>
  <Modal title="Keyboard shortcuts" wide @close="$emit('close')">
    <div class="groups">
      <section v-for="g in GROUPS" :key="g.title">
        <h3>{{ g.title }}</h3>
        <dl>
          <template v-for="[label, keys] in g.rows" :key="label">
            <dt>{{ label }}</dt>
            <dd><kbd>{{ keys }}</kbd></dd>
          </template>
        </dl>
      </section>
    </div>
  </Modal>
</template>

<style scoped>
.groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 18px 24px; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 8px; }
dl { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; margin: 0; font-size: 13.5px; align-items: center; }
dt { margin: 0; }
dd { margin: 0; text-align: right; white-space: nowrap; }
</style>
