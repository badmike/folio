<script setup lang="ts" generic="T extends string | number">
import type { IconName } from '../icons'
import Icon from './Icon.vue'
import StyleGlyph from './StyleGlyph.vue'

/** A row of exclusive icon/text buttons (Excalidraw-style option group). 'mixed' / undefined shows no active state. */
export interface Option<V> { value: V; label: string; glyph?: string; icon?: IconName; text?: string }
const props = defineProps<{ options: Option<T>[]; modelValue: T | 'mixed' | undefined; name: string }>()
const emit = defineEmits<{ (e: 'pick', v: T): void }>()
const active = (v: T) => typeof v === 'number' && typeof props.modelValue === 'number' ? Math.abs(v - props.modelValue) < 0.01 : v === props.modelValue
</script>

<template>
  <div class="opt-row" role="radiogroup" :aria-label="name">
    <button
      v-for="o in options" :key="String(o.value)" type="button" role="radio" class="opt" :class="{ on: active(o.value) }"
      :aria-checked="active(o.value)" :aria-label="o.label" :title="o.label" :data-testid="`${name.toLowerCase().replace(/\W+/g, '-')}-${o.value}`"
      @click="emit('pick', o.value)"
    >
      <StyleGlyph v-if="o.glyph" :name="o.glyph" />
      <Icon v-else-if="o.icon" :name="o.icon" :size="20" />
      <span v-else class="txt">{{ o.text }}</span>
    </button>
  </div>
</template>

<style scoped>
.opt-row { display: flex; flex-wrap: wrap; gap: 6px; }
.opt {
  width: 36px; height: 34px; border-radius: var(--radius); border: 1px solid transparent; background: var(--surface-2); color: var(--text);
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
}
.opt:hover { background: var(--surface-3); }
.opt.on { background: var(--accent-soft); color: var(--accent-strong); border-color: var(--accent); }
.opt:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.txt { font-weight: 650; font-size: 14px; }
</style>
