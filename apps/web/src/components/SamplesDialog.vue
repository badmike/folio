<script setup lang="ts">
import type { InkStroke } from '@folio/document'
import type { CalibrationSample } from '@folio/recognition'
import { computed, ref } from 'vue'
import { downloadBlob } from '../services/diagnostics'
import { settings } from '../services/settings'
import Modal from './Modal.vue'
import WritingPad from './WritingPad.vue'

defineEmits<{ (e: 'close'): void }>()

/** Short note-style lines: everyday words, names, digits, punctuation and umlauts. */
const LINES: Record<string, string[]> = {
  en: [
    'The quick brown fox jumps over the lazy dog.',
    'Call Maria at 4:30 about the June report.',
    'Exam topics: vectors, limits and 12 proofs.',
    'Buy milk, eggs, bread and two lemons.',
    'Why does the proof fail for n = 0?',
    'Meeting moved to Thursday, room 318.',
    'Energy is conserved in a closed system.',
    'Read chapter 7 before next week.',
    'Kinetic energy grows with velocity squared.',
    'Ask Jonas about the quiz results.',
    'Deadline: March 15, hand in by noon.',
    'A matrix is invertible if det(A) is not zero.',
    'Remember to back up the project files.',
    'First draft is done, review it tomorrow.',
    'Photosynthesis turns light into sugar.',
    'Train leaves at 7:52 from platform 9.',
    'Example: f(x) = 3x + 5, so f(2) = 11.',
    'Key idea: divide the problem, then merge.',
    'Zoe paid 48 euros for the textbook.',
    'Supply and demand set the market price.',
    'Open question: which method is faster?',
    'Note: the sample size was only 26.',
    'Voltage equals current times resistance.',
    'Summary: growth slowed in the third quarter.',
    'Check every unit before you calculate.',
    'Next steps: test, fix, write it up.',
    'The cell wall protects the plant cell.',
    'Exercise 4b is harder than it looks!',
    'Quote the source and give the page number.',
    'Jazz, quartz and wax: odd letters to write.',
  ],
  de: [
    'Franz jagt im komplett verwahrlosten Taxi quer durch Bayern.',
    'Treffen am Montag um 9 Uhr in Raum 214.',
    'Übung: Integrale, Grenzwerte und Beweise.',
    'Milch, Eier, Brot und zwei Äpfel kaufen.',
    'Warum gilt der Satz nicht für n = 0?',
    'Die Vorlesung fällt am Donnerstag aus.',
    'Energie bleibt im geschlossenen System erhalten.',
    'Kapitel 7 bis nächste Woche lesen.',
    'Die Lösung der Gleichung ist x = 12.',
    'Jonas nach den Ergebnissen der Prüfung fragen.',
    'Abgabe: 15. März, spätestens um 12 Uhr.',
    'Eine Matrix ist invertierbar, wenn det(A) nicht null ist.',
    'Größe und Gewicht müssen noch gemessen werden.',
    'Der erste Entwurf ist fertig, morgen prüfen.',
    'Die Photosynthese wandelt Licht in Zucker um.',
    'Der Zug fährt um 7:52 von Gleis 9.',
    'Beispiel: f(x) = 3x + 5, also f(2) = 11.',
    'Wichtig: erst teilen, dann zusammenführen.',
    'Zoe hat 48 Euro für das Buch bezahlt.',
    'Angebot und Nachfrage bestimmen den Preis.',
    'Offene Frage: Welches Verfahren ist schneller?',
    'Hinweis: Die Stichprobe umfasste nur 26 Personen.',
    'Spannung ist Stromstärke mal Widerstand.',
    'Zusammenfassung: Das Wachstum wurde schwächer.',
    'Vor dem Rechnen alle Einheiten prüfen.',
    'Nächste Schritte: testen, verbessern, aufschreiben.',
    'Die Zellwand schützt die Pflanzenzelle.',
    'Aufgabe 4b ist schwieriger als gedacht!',
    'Quelle angeben und Seitenzahl nennen.',
    'Fußball, Müsli und Straße: Wörter mit Umlauten und ß.',
  ],
}

/** All lines of the recognition languages, alternating between them. */
const lines = computed(() => {
  const langs = settings.languages.filter((l) => LINES[l])
  const pools = (langs.length ? langs : ['en']).map((l) => LINES[l])
  return pools[0].flatMap((_, i) => pools.map((p) => p[i]))
})

const step = ref(0)
const written = ref<InkStroke[][]>([])
const current = computed({
  get: () => written.value[step.value] ?? [],
  set: (strokes) => { written.value[step.value] = strokes },
})
const count = computed(() => written.value.filter((s) => s?.length).length)
const last = computed(() => step.value === lines.value.length - 1)

function save() {
  const samples: CalibrationSample[] = lines.value.flatMap((text, i) => (written.value[i]?.length ? [{ text, strokes: written.value[i] }] : []))
  downloadBlob(new Blob([JSON.stringify(samples)], { type: 'application/json' }), 'folio-handwriting-samples.json')
}
</script>

<template>
  <Modal title="Record handwriting samples" wide @close="$emit('close')">
    <p class="muted">Line {{ step + 1 }} of {{ lines.length }}. Write it on one line, the way you normally write. Skip any line you like.</p>
    <p class="line">{{ lines[step] }}</p>
    <WritingPad :key="step" v-model="current" />

    <template #footer>
      <button class="btn ghost small" :disabled="!current.length" @click="current = []">Clear</button>
      <span class="spacer" />
      <button class="btn small" :disabled="step === 0" @click="step--">Back</button>
      <button class="btn small" data-testid="samples-next" :disabled="last" @click="step++">{{ current.length ? 'Next' : 'Skip' }}</button>
      <button class="btn primary small" data-testid="samples-save" :disabled="!count" @click="save">Save {{ count }} to file</button>
    </template>
  </Modal>
</template>

<style scoped>
.line { margin: 10px 0 14px; font-size: 18px; font-weight: 600; color: var(--text-strong); }
.spacer { flex: 1; }
</style>
