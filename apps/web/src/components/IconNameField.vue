<script lang="ts">
/** What IconNameField edits: a name with an optional icon and colour. */
export interface IconNameValue {
  name: string
  icon: string | null
  color: string | null
}
</script>

<script setup lang="ts">
import { ref, useId } from 'vue'
import ColorSelect from './ColorSelect.vue'
import IconGrid from './IconGrid.vue'

/** Name input with an icon picker and a colour picker in front of it (folders, tags). */
defineProps<{ label?: string; placeholder?: string; disabled?: boolean }>()
const model = defineModel<IconNameValue>({ required: true })

const id = useId()
const input = ref<HTMLInputElement | null>(null)

function set<K extends keyof IconNameValue>(key: K, value: IconNameValue[K]) {
  model.value = { ...model.value, [key]: value }
}

defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <div class="field">
    <label v-if="label" :for="id">{{ label }}</label>
    <div class="controls">
      <IconGrid :model-value="model.icon" :color="model.color" :disabled="disabled" @update:model-value="set('icon', $event ?? null)" />
      <ColorSelect :model-value="model.color" :disabled="disabled" @update:model-value="set('color', $event ?? null)" />
      <input :id="id" ref="input" class="input" :value="model.name" :placeholder="placeholder" :disabled="disabled" autocomplete="off"
             data-testid="icon-name-input" @input="set('name', ($event.target as HTMLInputElement).value)" />
    </div>
  </div>
</template>

<style scoped>
.controls { display: flex; gap: 6px; }
.controls .input { flex: 1; min-width: 0; }
</style>
