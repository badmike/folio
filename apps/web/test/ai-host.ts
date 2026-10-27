import { NotebookDocument } from '@folio/document'
import type { ApprovalDecision, ApprovalRequest, HostView, ToolHost } from '../src/ai/host'
import type { ToolCall } from '../src/ai/protocol'

export const VIEWPORT = { x: 0, y: 0, width: 1200, height: 800 }

/** A ToolHost over in-memory notebooks; the first one is open, on its first page. */
export function fakeHost(docs: NotebookDocument[], decisions: ApprovalDecision[] = []) {
  const byId = new Map(docs.map((d) => [d.id, d]))
  const approvals: ApprovalRequest[] = []
  const highlights: string[][] = []
  const open = docs[0]
  let view: HostView | null = { notebookId: open.id, pageId: open.pages()[0].id, viewport: VIEWPORT, selection: [] }
  const doc = (id: string) => {
    const d = byId.get(id)
    if (!d) throw new Error(`notebook ${id} not found`)
    return d
  }
  const host: ToolHost = {
    view: () => view,
    withNotebook: async (id, fn) => fn(doc(id)),
    apply: (id, ops) => doc(id).apply(ops),
    search: async () => [],
    render: async () => 'iVBORw0KGgo=',
    asset: async () => undefined,
    approve: async (req) => {
      approvals.push(req)
      return decisions.shift() ?? 'deny'
    },
    ask: async () => ({ dismissed: true }),
    highlight: (_nb, _page, ids) => highlights.push(ids),
  }
  return { host, approvals, highlights, setView: (v: HostView | null) => (view = v) }
}

export const notebook = (title: string) => NotebookDocument.create({ title })

let n = 0
export const call = (name: ToolCall['name'], input: unknown): ToolCall => ({ toolCallId: `call-${++n}`, name, input })
