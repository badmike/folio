import type { NotebookDocumentApi, TextObject } from '@folio/document'

export function objectsOfType(doc: NotebookDocumentApi, pageId: string, type: 'text'): TextObject[] {
  return doc.objects(pageId).filter((o) => o.type === type && !o.supersededBy) as TextObject[]
}
