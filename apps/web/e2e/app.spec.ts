import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { countType, drawStroke, hostBox, inkCount, nonBackgroundPixels, wave } from './helpers'

/**
 * One serial user journey against `vite build && vite preview` in real Chromium
 * (OPFS + SQLite-WASM, WebGL, service worker). Screenshots go to test-results/ for review.
 */
test.describe.configure({ mode: 'serial' })

let context: BrowserContext
let page: Page
const problems: string[] = []
const shot = (name: string) => page.screenshot({ path: `test-results/e2e-${name}.png` })

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  await context.addInitScript(() => localStorage.setItem('folio.debug', '1'))
  page = await context.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`)
  })
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`))
})
test.afterAll(async () => {
  await context.close()
})

test('first run shows the Welcome notebook', async () => {
  await page.goto('/')
  await expect(page.getByTestId('notebook-card')).toHaveCount(1)
  await expect(page.getByTestId('notebook-card')).toContainText('Welcome')
  await shot('01-library')
})

test('welcome notebook renders through WebGL', async () => {
  await page.getByTestId('notebook-card').locator('button.thumb').click()
  await expect(page.getByTestId('notebook-screen')).toBeVisible()
  await expect.poll(() => page.evaluate(() => !!(window as any).__folio?.editor)).toBe(true)
  await page.waitForTimeout(800)
  const kind = await page.evaluate(() => {
    const gl = (window as any).__folio.editor.renderer.gl
    return gl ? `webgl${gl.getParameter(gl.VERSION).includes('2.0') ? '2' : '1'}` : 'canvas2d'
  })
  expect(kind).toMatch(/webgl/)
  const b = await hostBox(page)
  // dark pixels of the heading/diagram must be on screen
  const dark = await nonBackgroundPixels(page, { x: b.x + 300, y: b.y + 150, width: 700, height: 500 })
  expect(dark).toBeGreaterThan(1500)
  await shot('02-welcome')
  await page.getByTestId('back').click()
  await expect(page.getByTestId('new-notebook')).toBeVisible()
})

let clip = { x: 0, y: 0, width: 0, height: 0 }
let blankPixels = 0

test('create a notebook and draw strokes (painted by WebGL)', async () => {
  await page.getByTestId('new-notebook').click()
  await page.getByTestId('new-title').fill('E2E Notes')
  await page.getByTestId('create-notebook').click()
  await expect(page.getByTestId('title')).toHaveText('E2E Notes')
  await expect.poll(() => page.evaluate(() => !!(window as any).__folio?.editor)).toBe(true)

  const b = await hostBox(page)
  clip = { x: b.x + 200, y: b.y + 300, width: 500, height: 200 }
  blankPixels = await nonBackgroundPixels(page, clip)
  await page.getByTestId('tool-pen').click()
  await drawStroke(page, wave(240, 420))
  await drawStroke(page, wave(240, 360))
  await drawStroke(page, wave(240, 480))
  await expect.poll(() => inkCount(page)).toBe(3)
  await page.waitForTimeout(400)
  expect(await nonBackgroundPixels(page, clip)).toBeGreaterThan(blankPixels + 300) // strokes are actually painted
  await shot('03-drawn')
})

test('undo and redo', async () => {
  await page.getByTestId('undo').click()
  expect(await inkCount(page)).toBe(2)
  await page.getByTestId('redo').click()
  expect(await inkCount(page)).toBe(3)
})

test('strokes survive a reload', async () => {
  await page.waitForTimeout(600)
  await page.reload()
  await expect.poll(() => page.evaluate(() => !!(window as any).__folio?.editor), { timeout: 30_000 }).toBe(true)
  expect(await inkCount(page)).toBe(3)
  await page.waitForTimeout(500)
  expect(await nonBackgroundPixels(page, clip)).toBeGreaterThan(blankPixels + 300)
  await shot('04-after-reload')
})

test('shape tool draws a rectangle', async () => {
  await page.getByTestId('tool-shape').click() // selects the tool (options open on second click)
  await page.getByTestId('tool-shape').click()
  await page.getByTestId('shape-rectangle').click()
  await page.getByTestId('tool-shape').click()
  await drawStroke(page, [[700, 200], [800, 250], [900, 330]])
  await expect.poll(() => countType(page, 'shape')).toBe(1)
  await shot('05-shape')
})

test('text tool: type text', async () => {
  await page.getByTestId('tool-text').click()
  const b = await hostBox(page)
  await page.mouse.click(b.x + 260, b.y + 620)
  await page.keyboard.type('Photosynthesis converts light')
  await page.keyboard.press('Escape')
  await expect.poll(() => countType(page, 'text')).toBe(1)
  await shot('06-text')
})

test('leaving the notebook and searching finds the text and navigates to it', async () => {
  await page.waitForTimeout(500)
  await page.getByTestId('back').click()
  await page.getByTestId('search-input').fill('photosynth')
  const hit = page.getByTestId('search-hit').first()
  await expect(hit).toBeVisible()
  await expect(hit.locator('mark')).toContainText(/photosynth/i)
  await shot('07-search')
  await hit.click()
  await expect(page).toHaveURL(/\/n\/.+\?.*obj=/)
  await expect.poll(() => page.evaluate(() => (window as any).__folio?.ctl?.highlighted?.value === true), { timeout: 15_000 }).toBe(true)
  await shot('08-search-target')
})

test('export markdown contains the typed text', async () => {
  await page.getByTestId('export-menu').click()
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Markdown/ }).click()])
  expect(dl.suggestedFilename()).toBe('E2E Notes.md')
  const path = await dl.path()
  expect(readFileSync(path!, 'utf8')).toContain('Photosynthesis converts light')
})

test('clean up converts a hand-drawn rectangle into a shape (and restores ink)', async () => {
  await page.getByTestId('zoom-pct').click() // back to 100% after the search jump
  await expect(page.getByTestId('zoom-pct')).toHaveText('100%')
  await page.getByTestId('tool-pen').click()
  const cx = 1000, cy = 560
  await drawStroke(page, [[cx, cy], [cx + 150, cy + 2], [cx + 152, cy + 100], [cx + 2, cy + 102], [cx, cy + 3]], 30)
  await page.getByTestId('tool-select').click()
  await drawStroke(page, [[cx - 40, cy - 40], [cx + 200, cy + 150]]) // marquee
  await expect(page.getByTestId('cleanup')).toBeVisible()
  const shapesBefore = await countType(page, 'shape')
  await page.getByTestId('cleanup').click()
  await expect.poll(() => countType(page, 'shape'), { timeout: 30_000 }).toBe(shapesBefore + 1)
  await shot('09-cleanup')
  await expect(page.getByTestId('restore-ink')).toBeVisible()
  await page.getByTestId('restore-ink').click()
  await expect.poll(() => countType(page, 'shape')).toBe(shapesBefore)
})

test('handwriting is recognized offline (Tesseract) and becomes searchable', async () => {
  await page.getByTestId('tool-pen').click()
  const letters: Record<string, [number, number][][]> = {
    H: [[[0, 0], [0, 80]], [[40, 0], [40, 80]], [[0, 40], [40, 40]]],
    E: [[[40, 0], [0, 0], [0, 80], [40, 80]], [[0, 40], [30, 40]]],
    L: [[[0, 0], [0, 80], [40, 80]]],
    O: [[[20, 0], [40, 15], [40, 65], [20, 80], [0, 65], [0, 15], [20, 0]]],
  }
  let x0 = 300
  for (const ch of 'HELLO') {
    for (const st of letters[ch]) await drawStroke(page, st.map(([x, y]) => [x0 + x, 640 + y] as [number, number]), 12)
    x0 += 70
  }
  await expect
    .poll(() => page.evaluate(() => {
      const f = (window as any).__folio
      return f.doc.recognitions(f.editor.pageId).some((r: any) => r.kind === 'text' && /hello/i.test(r.text ?? ''))
    }), { timeout: 60_000 })
    .toBe(true)
  await page.getByTestId('open-search').click()
  await page.getByTestId('nb-search-input').fill('hello')
  await expect(page.getByTestId('nb-search-hit').first()).toContainText(/handwriting/)
  await page.getByTestId('nb-search-hit').first().click()
  await shot('09b-handwriting-search')
  await page.getByTestId('open-search').click()
})

test('cleanup mode "ask" offers to convert ink after a pause', async () => {
  await page.getByTestId('zoom-pct').click()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
  await shot('09c-settings')
  await page.keyboard.press('Escape')
  await page.getByTestId('tool-pen').click()
  const before = await countType(page, 'shape')
  await drawStroke(page, [[700, 560], [850, 562], [852, 660], [702, 662], [700, 563]], 30)
  await expect(page.getByTestId('cleanup-prompt')).toBeVisible({ timeout: 30_000 })
  await shot('09d-ask-toast')
  await page.getByTestId('cleanup-apply').click()
  await expect.poll(() => countType(page, 'shape')).toBe(before + 1)
  // the recognized handwriting from the previous step is offered in the same batch
  const texts = await page.evaluate(() => {
    const f = (window as any).__folio
    return f.doc.objects(f.editor.pageId).filter((o: any) => o.type === 'text' && o.sourceStrokeIds?.length).map((o: any) => o.text)
  })
  expect(texts.join(' ')).toMatch(/hello/i)
  // back to the default (keep ink) so the remaining steps are unaffected
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Keep my ink' }).click()
  await page.keyboard.press('Escape')
})

test('settings dialog and page panel', async () => {
  await page.getByTestId('open-pages').click()
  await page.getByTestId('bg-grid').click()
  await page.waitForTimeout(300)
  await shot('10-pages-grid')
  await page.getByTestId('add-page').click()
  await page.getByRole('menuitem', { name: /A4/ }).click()
  await expect(page.getByTestId('page-item')).toHaveCount(2)
  await shot('11-page-a4')
})

test('works offline after the service worker is active', async () => {
  await page.getByTestId('back').click()
  await expect(page.getByTestId('offline-ready')).toBeVisible({ timeout: 60_000 })
  // make sure the SW controls the page and finished precaching
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.reload()
  await expect(page.getByTestId('new-notebook')).toBeVisible()
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByTestId('notebook-card').first()).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('notebook-card').filter({ hasText: 'E2E Notes' }).locator('button.thumb').click()
  await expect.poll(() => page.evaluate(() => !!(window as any).__folio?.editor), { timeout: 30_000 }).toBe(true)
  // the notebook reopens on the A4 page added earlier; the strokes live on page 1
  const total = await page.evaluate(() => {
    const f = (window as any).__folio
    return f.doc.pages().flatMap((p: any) => f.doc.objects(p.id)).filter((o: any) => o.type === 'ink' && !o.supersededBy).length
  })
  expect(total).toBeGreaterThanOrEqual(4) // waves + restored rectangle stroke + any ink not converted
  await shot('12-offline')
  await context.setOffline(false)
})

test('no unexpected console errors', async () => {
  const relevant = problems.filter((p) => !/Failed to load resource.*(net::ERR_INTERNET_DISCONNECTED|ERR_FAILED)/.test(p))
  expect(relevant).toEqual([])
})
