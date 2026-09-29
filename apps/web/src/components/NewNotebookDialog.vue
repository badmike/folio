<script setup lang="ts">
import type { BackgroundPattern } from '@folio/document'
import { onMounted, ref } from 'vue'
import { settings, type DefaultPageType } from '../services/settings'
import Modal from './Modal.vue'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'create', o: { title: string; pageType: DefaultPageType; pattern: BackgroundPattern }): void
}>()

const title = ref('')
const pageType = ref<DefaultPageType>(settings.defaultPageType)
const pattern = ref<BackgroundPattern>(settings.defaultPattern)
const input = ref<HTMLInputElement | null>(null)
onMounted(() => input.value?.focus())

const TYPES: { v: DefaultPageType; label: string; sub: string }[] = [
  { v: 'infinite', label: 'Infinite', sub: 'Endless canvas' },
  { v: 'A4', label: 'A4', sub: 'Fixed pages' },
  { v: 'Letter', label: 'Letter', sub: 'Fixed pages' },
  { v: 'iPad', label: 'iPad', sub: 'Screen-sized pages' },
]
const PATTERNS: { v: BackgroundPattern; label: string }[] = [
  { v: 'blank', label: 'Blank' }, { v: 'ruled', label: 'Ruled' }, { v: 'grid', label: 'Grid' }, { v: 'dot', label: 'Dots' },
]
function submit() {
  emit('create', { title: title.value, pageType: pageType.value, pattern: pattern.value })
}
</script>

<template>
  <Modal title="New notebook" @close="emit('close')">
    <form id="new-nb" @submit.prevent="submit">
      <div class="field">
        <label for="nb-title">Title</label>
        <input id="nb-title" ref="input" v-model="title" class="input" placeholder="Untitled" autocomplete="off" data-testid="new-title" />
      </div>
      <div class="field">
        <span class="label">Page type</span>
        <div class="types">
          <button v-for="t in TYPES" :key="t.v" type="button" class="type" :class="{ on: pageType === t.v }" :data-testid="`type-${t.v}`" @click="pageType = t.v">
            <strong>{{ t.label }}</strong><span class="muted">{{ t.sub }}</span>
          </button>
        </div>
      </div>
      <div class="field">
        <span class="label">Background</span>
        <div class="seg">
          <button v-for="p in PATTERNS" :key="p.v" type="button" :class="{ on: pattern === p.v }" @click="pattern = p.v">{{ p.label }}</button>
        </div>
      </div>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <button class="btn primary" type="submit" form="new-nb" data-testid="create-notebook">Create</button>
    </template>
  </Modal>
</template>

<style scoped>
.types { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.type { display: flex; flex-direction: column; text-align: left; padding: 10px 12px; border: 1px solid var(--border); background: var(--surface); border-radius: 10px; min-height: 56px; }
.type.on { border-color: var(--accent); background: var(--accent-soft); }
.type span { font-size: 12.5px; }
</style>
