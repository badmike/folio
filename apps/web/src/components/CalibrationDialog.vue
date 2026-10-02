<script setup lang="ts">
import type { InkStroke } from '@folio/document'
import type { CalibrationResult } from '@folio/recognition'
import { computed, ref, shallowRef } from 'vue'
import { requireServices } from '../app'
import { diagnostics } from '../services/diagnostics'
import { settings } from '../services/settings'
import Modal from './Modal.vue'
import WritingPad from './WritingPad.vue'

defineEmits<{ (e: 'close'): void }>()
const svc = requireServices()

/** Sentences cover most letters, digits and punctuation of each language. */
const SENTENCES: Record<string, string[]> = {
  en: ['The quick brown fox jumps over the lazy dog.', 'Call Maria at 4:30 about the June report.', 'Exam topics: vectors, limits and 12 proofs.'],
  de: ['Franz jagt im komplett verwahrlosten Taxi quer durch Bayern.', 'Treffen am Montag um 9 Uhr in Raum 214.', 'Übung: Integrale, Grenzwerte und Beweise.'],
}
const COUNT = 3

/** Three sentences, alternating between the recognition languages. */
const sentences = computed(() => {
  const langs = settings.languages.filter((l) => SENTENCES[l])
  const pool = langs.length ? langs : ['en']
  return Array.from({ length: COUNT }, (_, i) => SENTENCES[pool[i % pool.length]][Math.floor(i / pool.length)])
})

const step = ref(0)
const samples = ref<InkStroke[][]>(Array.from({ length: COUNT }, () => []))
const phase = ref<'write' | 'running' | 'done' | 'failed'>('write')
const progress = ref({ done: 0, total: 1 })
const result = shallowRef<CalibrationResult | null>(null)
const last = computed(() => step.value === COUNT - 1)
const pct = (x: number) => Math.round(x * 100)

async function next() {
  if (!last.value) return void step.value++
  phase.value = 'running'
  try {
    const list = sentences.value.map((text, i) => ({ text, strokes: samples.value[i] }))
    result.value = await svc.recognition.calibrate(list, (done, total) => { progress.value = { done, total } })
    phase.value = 'done'
  } catch (e) {
    diagnostics.log('calibrate', e)
    phase.value = 'failed'
  }
}
</script>

<template>
  <Modal title="Calibrate handwriting" wide @close="phase !== 'running' && $emit('close')">
    <template v-if="phase === 'write'">
      <p class="muted">Step {{ step + 1 }} of {{ COUNT }}. Write this sentence on one line, the way you normally write.</p>
      <p class="sentence">{{ sentences[step] }}</p>
      <WritingPad :key="step" v-model="samples[step]" />
    </template>
    <div v-else-if="phase === 'running'" class="status">
      <p>Trying recognition settings on your handwriting, {{ progress.done }} of {{ progress.total }}.</p>
      <progress :value="progress.done" :max="progress.total" />
    </div>
    <div v-else-if="phase === 'done' && result" class="status" data-testid="calibration-result">
      <p v-if="result.improved">
        Wrong characters on your samples: <strong>{{ pct(result.before) }}%</strong> before, <strong>{{ pct(result.after) }}%</strong> now.
        folio uses these settings from now on.
      </p>
      <p v-else>The standard settings already read your handwriting best ({{ pct(result.before) }}% wrong characters), so nothing changed.</p>
      <p class="muted">folio also noted which letters it still mixes up, and fixes them in words you have written or typed before.</p>
    </div>
    <p v-else class="status">Calibration could not run. Recognition needs its offline files, try again once folio is fully loaded.</p>

    <template #footer>
      <template v-if="phase === 'write'">
        <button class="btn ghost small" :disabled="!samples[step].length" @click="samples[step] = []">Clear</button>
        <span class="spacer" />
        <button v-if="step > 0" class="btn small" @click="step--">Back</button>
        <button class="btn primary small" data-testid="calibration-next" :disabled="!samples[step].length" @click="next">
          {{ last ? 'Finish' : 'Next' }}
        </button>
      </template>
      <button v-else class="btn primary small" :disabled="phase === 'running'" @click="$emit('close')">Done</button>
    </template>
  </Modal>
</template>

<style scoped>
.sentence { margin: 10px 0 14px; font-size: 18px; font-weight: 600; color: var(--text-strong); }
.status p { margin: 0 0 10px; line-height: 1.5; }
progress { width: 100%; accent-color: var(--accent); }
.spacer { flex: 1; }
</style>
