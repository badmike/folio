import { tool, type Executor } from './kit'
import { arr, bool, obj, opt, str } from './validate'

export const ask_user: Executor = tool(
  obj({
    question: str({ min: 1, max: 500 }),
    options: arr(obj({ label: str({ min: 1, max: 80 }), description: opt(str({ max: 200 })) }), { min: 2, max: 4 }),
    allowFreeText: opt(bool),
  }),
  async (input, { host }) => {
    const answer = await host.ask({ ...input, allowFreeText: input.allowFreeText ?? true })
    if ('dismissed' in answer) return { output: { dismissed: true, note: 'The user dismissed the question. Continue with your best judgement or stop.' } }
    return { output: { answer } }
  },
)
