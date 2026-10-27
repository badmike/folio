<script setup lang="ts">
import { HAND_LEVELS, THEME_IDS, THEME_PRESETS, type HandLevel, type ThemeId, type ThemeOptions } from '@folio/document'
import { FONT_FAMILIES, FONT_LABELS } from '@folio/renderer'
import { computed, ref } from 'vue'
import { requireServices } from '../app'
import { settings } from '../services/settings'
import { themeFor, themeOverrides } from '../services/themes'
import ColorPicker from './ColorPicker.vue'
import Switch from './Switch.vue'
import ThemePicker from './ThemePicker.vue'
import ThemePreview from './ThemePreview.vue'

/**
 * Settings > Themes: the default theme of new notebooks (this device) and per-theme
 * customisations, which sync through the workspace so every device draws a notebook alike.
 */
const svc = requireServices()

const editing = ref<ThemeId>(settings.defaultTheme)
const theme = computed(() => themeFor(editing.value))
const customised = computed(() => Object.keys(themeOverrides.value[editing.value] ?? {}).length > 0)

/** Store a knob as an override; a value equal to the preset's drops the override. */
function set<K extends keyof ThemeOptions>(key: K, value: ThemeOptions[K]) {
  const next = { ...themeOverrides.value[editing.value] }
  if (value === THEME_PRESETS[editing.value].defaults[key]) delete next[key]
  else next[key] = value
  svc.workspace.doc.setThemeOverrides(editing.value, next)
}

function reset() {
  svc.workspace.doc.setThemeOverrides(editing.value, null)
}

const font = computed({ get: () => theme.value.font, set: (v) => set('font', v) })
const uppercase = computed({ get: () => theme.value.uppercase, set: (v) => set('uppercase', v) })
const shadow = computed({ get: () => theme.value.shadow, set: (v) => set('shadow', v) })
const strokeScale = computed({ get: () => theme.value.strokeScale, set: (v) => set('strokeScale', Number(v)) })

/** Themes with hand levels: the theme sets how the pen overdraws, each shape's Sloppiness its wiggle. */
const hasHands = computed(() => !!THEME_PRESETS[editing.value].hands)
const OVERDRAW: Record<HandLevel, string> = { refined: 'Refined', artist: 'Artist', sloppy: 'Sloppy' }

const SKETCHINESS: { v: number | null; label: string }[] = [
  { v: null, label: 'Per shape' }, { v: 0, label: 'None' }, { v: 0.5, label: 'Light' },
  { v: 1, label: 'Medium' }, { v: 1.6, label: 'Sketchy' }, { v: 2.5, label: 'Wild' },
]

const picking = ref<'paperLight' | 'paperDark' | null>(null)
const PAPERS = [{ key: 'paperLight', label: 'Light' }, { key: 'paperDark', label: 'Dark' }] as const
</script>

<template>
  <div class="setting stack">
    <div class="text">
      <div class="name">Default theme</div>
      <p>New notebooks start with it, and notebooks that never picked a theme use it. Change a notebook's theme from its menu.</p>
    </div>
    <ThemePicker v-model="settings.defaultTheme" label="Default theme" />
  </div>

  <div class="setting stack">
    <div class="text">
      <div class="name">Customise a theme</div>
      <p>Changes apply to every notebook using the theme, on all your devices.</p>
    </div>
    <div class="seg soft picks" role="radiogroup" aria-label="Theme to customise">
      <button v-for="id in THEME_IDS" :key="id" type="button" role="radio" :aria-checked="editing === id" :class="{ on: editing === id }"
              :data-testid="`customise-${id}`" @click="editing = id; picking = null">
        {{ THEME_PRESETS[id].label }}
      </button>
    </div>
    <div class="previews">
      <ThemePreview :theme="theme" />
      <ThemePreview :theme="theme" dark />
    </div>

    <div class="knob">
      <label class="label" for="theme-font">Font</label>
      <select id="theme-font" v-model="font" class="input" :style="{ fontFamily: FONT_FAMILIES[font] }">
        <option v-for="f in FONT_LABELS" :key="f.family" :value="f.family" :style="{ fontFamily: FONT_FAMILIES[f.family] }">{{ f.label }}</option>
      </select>
    </div>
    <div class="knob">
      <span class="label">Capitals</span>
      <Switch v-model="uppercase" label="Capitals" data-testid="theme-uppercase" />
    </div>
    <div class="knob">
      <span class="label">Offset shadow</span>
      <Switch v-model="shadow" label="Offset shadow" data-testid="theme-shadow" />
    </div>
    <div class="knob">
      <label class="label" for="theme-weight">Stroke weight</label>
      <input id="theme-weight" v-model.number="strokeScale" type="range" min="0.5" max="3" step="0.25" />
      <span class="value">{{ strokeScale }}×</span>
    </div>
    <div v-if="hasHands" class="knob wrap">
      <div class="label">
        Overdraw
        <p class="hint">How far lines run past corners, retracing and pen pressure. Each shape's Sloppiness adds its wiggle on top.</p>
      </div>
      <div class="seg soft" role="radiogroup" aria-label="Overdraw">
        <button v-for="h in HAND_LEVELS" :key="h" type="button" role="radio" :aria-checked="theme.hand === h"
                :class="{ on: theme.hand === h }" :data-testid="`theme-overdraw-${h}`" @click="set('hand', h)">{{ OVERDRAW[h] }}</button>
      </div>
    </div>
    <div v-else class="knob wrap">
      <span class="label">Sketchiness</span>
      <div class="seg soft" role="radiogroup" aria-label="Sketchiness">
        <button v-for="s in SKETCHINESS" :key="String(s.v)" type="button" role="radio" :aria-checked="theme.roughness === s.v"
                :class="{ on: theme.roughness === s.v }" @click="set('roughness', s.v)">{{ s.label }}</button>
      </div>
    </div>
    <div class="knob wrap">
      <span class="label">Paper</span>
      <div class="papers">
        <button v-for="p in PAPERS" :key="p.key" type="button" class="paper" data-picker-anchor :aria-expanded="picking === p.key"
                :data-testid="`theme-${p.key}`" @click="picking = picking === p.key ? null : p.key">
          <span class="sw" :style="{ background: theme[p.key] }" />{{ p.label }}
        </button>
      </div>
      <ColorPicker v-if="picking" class="inline-picker" :model-value="theme[picking]" :allow-transparent="false"
                   :title="picking === 'paperLight' ? 'Light paper' : 'Dark paper'" @update:model-value="set(picking!, $event)" @close="picking = null" />
    </div>
    <div class="actions">
      <button type="button" class="btn" :disabled="!customised" data-testid="theme-reset" @click="reset">Reset {{ THEME_PRESETS[editing].label }}</button>
    </div>
  </div>
</template>

<style scoped>
.setting.stack { display: flex; flex-direction: column; align-items: stretch; gap: 12px; padding: 12px 14px; border-radius: var(--radius); background: color-mix(in srgb, var(--surface-2) 50%, var(--surface)); }
.name { font-size: 14px; font-weight: 600; color: var(--text-strong); }
.text p { margin: 3px 0 0; font-size: 13px; line-height: 1.45; color: var(--muted); }
.picks { display: grid; grid-template-columns: repeat(3, 1fr); }
.previews { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.previews :deep(.theme-preview) { box-shadow: 0 0 0 1px var(--border); }
.knob { display: flex; align-items: center; gap: 12px; min-height: 34px; }
.knob.wrap { flex-wrap: wrap; }
.knob .label { flex: 1; min-width: 120px; font-size: 13.5px; color: var(--text); }
.hint { margin: 2px 0 0; font-weight: 400; font-size: 12.5px; line-height: 1.4; color: var(--muted); }
.knob .input { min-width: 180px; min-height: 34px; font-size: 14px; }
.knob input[type='range'] { width: 160px; accent-color: var(--accent); }
.value { width: 44px; text-align: right; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
.papers { display: flex; gap: 6px; }
.paper { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 10px 0 6px; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); color: var(--text); font-size: 13px; }
.paper:hover { background: var(--surface-2); }
.sw { width: 18px; height: 18px; border-radius: 4px; box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.15); }
.inline-picker { width: 100%; box-shadow: none; }
.actions { display: flex; justify-content: flex-end; }
</style>
