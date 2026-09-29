import { computed } from 'vue'
import { services } from '../app'

/** The recognition service's "Clean up N items?" prompt, for the toast host. */
export const recognitionPrompt = computed(() => services.value?.recognition.prompt.value ?? null)
