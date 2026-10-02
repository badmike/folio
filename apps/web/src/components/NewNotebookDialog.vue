<script setup lang="ts">
import type { BackgroundPattern } from '@folio/document'
import { onMounted, ref } from 'vue'
import { settings, type DefaultPageType } from '../services/settings'
import { PATTERN_OPTIONS } from '../patterns'
import Modal from './Modal.vue'
import PatternGlyph from './PatternGlyph.vue'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'create', o: { title: string; pageType: DefaultPageType; pattern: BackgroundPattern }): void
}>()

const title = ref('')
const pageType = ref<DefaultPageType>(settings.defaultPageType)
const pattern = ref<BackgroundPattern>(settings.defaultPattern)
const input = ref<HTMLInputElement | null>(null)
onMounted(() => input.value?.focus())

/** Page types with the preview sheet size (px, real proportions; the infinite canvas is open-ended). */
const TYPES: { v: DefaultPageType; label: string; sub: string; w: number; h: number }[] = [
  { v: 'infinite', label: 'Infinite', sub: 'Endless canvas', w: 64, h: 46 },
  { v: 'A4', label: 'A4', sub: 'Fixed pages', w: 37, h: 52 },
  { v: 'Letter', label: 'Letter', sub: 'Fixed pages', w: 40, h: 52 },
  { v: 'iPad', label: 'iPad', sub: 'Screen-sized', w: 36, h: 52 },
]
const PATTERNS = PATTERN_OPTIONS
function submit() {
  emit('create', { title: title.value, pageType: pageType.value, pattern: pattern.value })
}
</script>

<template>
  <Modal title="New notebook" description="Pick a page type and a background. You can change both later, page by page." @close="emit('close')">
    <form id="new-nb" @submit.prevent="submit">
      <div class="field">
        <label for="nb-title">Title</label>
        <input id="nb-title" ref="input" v-model="title" class="input" placeholder="Untitled" autocomplete="off" data-testid="new-title" />
      </div>
      <div class="field">
        <span id="nb-type" class="label">Page type</span>
        <div class="types" role="radiogroup" aria-labelledby="nb-type">
          <button
            v-for="t in TYPES" :key="t.v" type="button" class="type" :class="{ on: pageType === t.v }" role="radio"
            :aria-checked="pageType === t.v" :data-testid="`type-${t.v}`" @click="pageType = t.v"
          >
            <span class="stage">
              <span class="sheet" :class="{ open: t.v === 'infinite' }" :style="{ width: `${t.w}px`, height: `${t.h}px` }"><PatternGlyph class="lines" :pattern="pattern" /></span>
            </span>
            <span class="name">{{ t.label }}</span>
            <span class="sub">{{ t.sub }}</span>
          </button>
        </div>
      </div>
      <div class="field">
        <span id="nb-bg" class="label">Background</span>
        <div class="seg soft patterns" role="radiogroup" aria-labelledby="nb-bg">
          <button
            v-for="p in PATTERNS" :key="p.v" type="button" role="radio" :aria-checked="pattern === p.v" :class="{ on: pattern === p.v }"
            :data-testid="`pattern-${p.v}`" @click="pattern = p.v"
          >
            <PatternGlyph class="glyph" :pattern="p.v" />
            <span>{{ p.label }}</span>
          </button>
        </div>
      </div>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <button class="btn primary" type="submit" form="new-nb" data-testid="create-notebook">Create notebook</button>
    </template>
  </Modal>
</template>

<style scoped>
.types { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.type {
  display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 10px 4px 9px;
  border: 1px solid transparent; border-radius: var(--radius); background: var(--surface-2); color: var(--text);
}
.type:hover { background: var(--surface-3); }
.type.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-strong); }
.type:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.stage { height: 56px; display: flex; align-items: center; justify-content: center; margin-bottom: 4px; }
.sheet {
  display: block; border-radius: 3px; background-color: var(--surface); border: 1px solid var(--border-strong);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
}
.sheet.open {
  border-style: dashed;
  -webkit-mask-image: radial-gradient(ellipse at center, #000 55%, transparent 100%);
  mask-image: radial-gradient(ellipse at center, #000 55%, transparent 100%);
}
.name { font-size: 13.5px; font-weight: 600; }
.sub { font-size: 11.5px; color: var(--muted); }
.type.on .sub { color: inherit; opacity: 0.75; }
.seg { display: flex; }
.seg button { flex: 1; }
.seg.patterns { display: grid; grid-template-columns: repeat(4, 1fr); }
.seg.patterns button { padding: 6px 4px 5px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.seg.patterns .glyph { width: 100%; height: 22px; border-radius: 3px; }
.sheet .lines { width: 100%; height: 100%; }
</style>
