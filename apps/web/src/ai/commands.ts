/** Slash commands and starter chips: the V1 presets, sent as ordinary user messages. */
export interface SlashCommand {
  id: string
  label: string
  hint: string
  prompt: string
}

export const SLASH_COMMANDS = [
  {
    id: 'summarize', label: 'Summarize page', hint: 'Short summary of the current page',
    prompt: 'Summarize this page: a one-line title, then short bullet points with the key ideas. Stick to what my notes say.',
  },
  {
    id: 'lecture', label: 'Lecture notes', hint: 'Structured notes from the whole notebook',
    prompt: 'Write structured lecture notes from this whole notebook: a heading per topic, key definitions in bold, and a short list of open questions at the end.',
  },
  {
    id: 'outline', label: 'Outline', hint: 'Hierarchical outline of the notebook',
    prompt: 'Make a hierarchical outline of this whole notebook as nested bullet lists.',
  },
  {
    id: 'flashcards', label: 'Flashcards', hint: 'Question and answer cards',
    prompt: 'Create study flashcards from this notebook, one card per item, each as **Q:** question and **A:** answer.',
  },
  {
    id: 'questions', label: 'Practice questions', hint: 'Questions with answers',
    prompt: 'Write practice questions on this notebook, a mix of recall and understanding, as a numbered list. Then add an "Answers" section with brief answers.',
  },
] as const satisfies readonly SlashCommand[]

export type SlashCommandId = (typeof SLASH_COMMANDS)[number]['id']
