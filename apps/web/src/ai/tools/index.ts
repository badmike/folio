/** Placeholder until the tools stream lands. The exported names and types are the contract. */
import type { ContextBuilder, CreateToolRunner, RevertEffects } from '../host'

const missing = (): never => { throw new Error('AI tools are not implemented yet') }

export const createToolRunner: CreateToolRunner = () => ({ run: async () => missing() })
export const revertEffects: RevertEffects = async () => missing()
export const contextBuilder: ContextBuilder = {
  environment: async () => missing(),
  selectionChip: async () => missing(),
  pageChip: async () => missing(),
  mentionChip: async () => missing(),
}
