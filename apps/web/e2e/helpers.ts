import type { Page } from '@playwright/test'

export async function inkCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const f = (window as any).__folio
    return f.doc.objects(f.editor.pageId).filter((o: any) => o.type === 'ink' && !o.supersededBy).length
  })
}

export async function countType(page: Page, type: string): Promise<number> {
  return page.evaluate((t) => {
    const f = (window as any).__folio
    return f.doc.objects(f.editor.pageId).filter((o: any) => o.type === t && !o.supersededBy).length
  }, type)
}

export async function hostBox(page: Page) {
  const box = await page.getByTestId('editor-host').boundingBox()
  if (!box) throw new Error('editor host not visible')
  return box
}

/** Draw a polyline with the mouse (page coordinates relative to the editor host). */
export async function drawStroke(page: Page, pts: [number, number][], steps = 3) {
  const b = await hostBox(page)
  await page.mouse.move(b.x + pts[0][0], b.y + pts[0][1])
  await page.mouse.down()
  for (const [x, y] of pts.slice(1)) await page.mouse.move(b.x + x, b.y + y, { steps })
  await page.mouse.up()
}

export function wave(x0: number, y0: number, n = 30): [number, number][] {
  return Array.from({ length: n }, (_, i) => [x0 + i * 8, y0 + Math.sin(i / 3) * 30] as [number, number])
}

/** Fraction of pixels that differ from the background colour in a clip (screenshot based). */
export async function nonBackgroundPixels(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number> {
  const png = await page.screenshot({ clip })
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) n++
    return n
  }, png.toString('base64'))
}

export async function openSettings(page: Page, section?: 'Account' | 'Handwriting' | 'Drawing' | 'Data & offline') {
  await page.getByTestId('main-menu').click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  if (section) await page.getByRole('dialog').getByRole('button', { name: section, exact: true }).click()
}

export async function newNotebook(page: Page, title: string) {
  await page.addInitScript(() => localStorage.setItem('folio.debug', '1'))
  await page.goto('/')
  await page.getByTestId('new-notebook').click()
  await page.getByTestId('new-title').fill(title)
  await page.getByTestId('create-notebook').click()
  await page.getByTestId('toolbar').waitFor()
  await page.waitForFunction(() => !!(window as any).__folio?.editor)
}

/** The notebook title is the header of the main menu. */
export async function notebookTitle(page: Page): Promise<string> {
  await page.getByTestId('main-menu').click()
  const t = await page.getByTestId('title').textContent()
  await page.keyboard.press('Escape')
  return t ?? ''
}

/** Back to the library via the main menu. */
export async function backToLibrary(page: Page) {
  await page.getByTestId('main-menu').click()
  await page.getByRole('menuitem', { name: 'Library' }).click()
}

/** Objects of a type on the current page (not superseded). */
export async function objectsOf(page: Page, type: string): Promise<any[]> {
  return page.evaluate((t) => {
    const f = (window as any).__folio
    return JSON.parse(JSON.stringify(f.doc.objects(f.editor.pageId).filter((o: any) => o.type === t && !o.supersededBy)))
  }, type)
}
