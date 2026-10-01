import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { drawStroke, wave } from '../e2e/helpers'
import { hasCargo, startStack, type Stack } from './harness'

/**
 * Two "devices" (separate browser contexts = separate OPFS/localStorage) sign in as the same
 * dev user against the real Rust server, then edit online and offline and must converge.
 */
test.describe.configure({ mode: 'serial' })
test.skip(!hasCargo(), 'cargo is not available: skipping the real-server sync e2e')

let stack: Stack
let ctxA: BrowserContext
let ctxB: BrowserContext
let A: Page
let B: Page
const problems: string[] = []

async function device(browser: Browser, name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await ctx.addInitScript(() => {
    localStorage.setItem('folio.debug', '1')
    localStorage.setItem('folio.devToken', 'dev:alice')
  })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${name}] ${m.text()}`) })
  page.on('pageerror', (e) => problems.push(`[${name}] pageerror ${e.message}`))
  return { ctx, page }
}

/** Ask the sync engine to run now (it listens for the browser's `online` event). */
const poke = (p: Page) => p.evaluate(() => window.dispatchEvent(new Event('online')))

/** Non-superseded object ids of the open page, sorted. */
const objectIds = (p: Page) =>
  p.evaluate(() => {
    const f = (window as any).__folio
    return f.doc.objects(f.editor.pageId).filter((o: any) => !o.supersededBy).map((o: any) => `${o.type}:${o.id}`).sort() as string[]
  })

const typeCount = async (p: Page, type: string) => (await objectIds(p)).filter((s) => s.startsWith(type + ':')).length

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000)
  stack = await startStack()
  const a = await device(browser, 'A')
  const b = await device(browser, 'B')
  ctxA = a.ctx; A = a.page
  ctxB = b.ctx; B = b.page
})

test.afterAll(async () => {
  await ctxA?.close()
  await ctxB?.close()
  stack?.stop()
})

test('device A creates a notebook and draws; device B receives notebook and strokes', async () => {
  await A.goto(stack.webBase)
  await A.getByTestId('new-notebook').click()
  await A.getByTestId('new-title').fill('Shared notebook')
  await A.getByTestId('create-notebook').click()
  await A.getByTestId('toolbar').waitFor()
  await expect.poll(() => A.evaluate(() => !!(window as any).__folio?.editor)).toBe(true)
  await drawStroke(A, wave(240, 380))
  await drawStroke(A, wave(240, 440))
  await drawStroke(A, wave(240, 500))
  await expect.poll(() => typeCount(A, 'ink')).toBe(3)

  // Device B: fresh profile, same account -> the notebook appears in its library after a sync.
  await B.goto(stack.webBase)
  await expect(B.getByTestId('new-notebook')).toBeVisible()
  await expect
    .poll(async () => { await poke(A); await poke(B); return B.getByTestId('notebook-card').filter({ hasText: 'Shared notebook' }).count() }, { timeout: 90_000, intervals: [1500] })
    .toBe(1)
  // The library entry can arrive before the notebook's content: B waits for it to sync, then opens.
  await B.getByTestId('notebook-card').filter({ hasText: 'Shared notebook' }).locator('button.thumb').click()
  await expect
    .poll(async () => { await poke(A); await poke(B); return B.evaluate(() => !!(window as any).__folio?.editor) }, { timeout: 60_000, intervals: [1500] })
    .toBe(true)
  await expect
    .poll(async () => { await poke(B); return typeCount(B, 'ink') }, { timeout: 60_000, intervals: [1500] })
    .toBe(3)
  expect(await objectIds(B)).toEqual(await objectIds(A))
})

test('continuous strokes sync automatically in both directions while both devices stay open', async () => {
  const initial = await typeCount(A, 'ink')
  const strokes = 8
  let finishedWriting = false
  const writing = (async () => {
    for (let i = 0; i < strokes; i++) await drawStroke(A, wave(260, 260 + i * 45, 20), 1)
    finishedWriting = true
  })()
  try {
    await expect.poll(() => typeCount(B, 'ink'), { timeout: 5000, intervals: [100] }).toBeGreaterThan(initial)
    expect(finishedWriting).toBe(false)
  } finally {
    await writing
  }
  await expect.poll(() => typeCount(B, 'ink'), { timeout: 5000, intervals: [100] }).toBe(initial + strokes)

  await drawStroke(B, wave(720, 280, 20), 1)
  await expect.poll(() => typeCount(A, 'ink'), { timeout: 5000, intervals: [100] }).toBe(initial + strokes + 1)
  expect(await objectIds(B)).toEqual(await objectIds(A))
})

test('concurrent offline edits on both devices converge after reconnecting', async () => {
  const initialInks = await typeCount(A, 'ink')
  // B reloads offline at the end: its service worker must finish precaching while still online
  await B.evaluate(async () => { await navigator.serviceWorker.ready })
  await ctxA.setOffline(true)
  await ctxB.setOffline(true)

  await drawStroke(A, wave(700, 380))
  await drawStroke(A, wave(700, 440))
  await expect.poll(() => typeCount(A, 'ink')).toBe(initialInks + 2)

  await B.getByTestId('tool-text').click()
  const host = (await B.getByTestId('editor-host').boundingBox())!
  await B.mouse.click(host.x + 300, host.y + 620)
  await B.keyboard.type('written offline on B')
  await B.keyboard.press('Escape')
  await expect.poll(() => typeCount(B, 'text')).toBe(1)

  // the engine notices it is offline (and nothing crossed over)
  await poke(A); await poke(B)
  await expect(A.getByTestId('sync-dot')).toHaveClass(/offline/)
  await expect(B.getByTestId('sync-dot')).toHaveClass(/offline/)
  expect(await typeCount(A, 'text')).toBe(0)
  expect(await typeCount(B, 'ink')).toBe(initialInks)

  await ctxA.setOffline(false)
  await ctxB.setOffline(false)
  await expect
    .poll(async () => {
      await poke(A); await poke(B)
      const [a, b] = [await objectIds(A), await objectIds(B)]
      return JSON.stringify(a) === JSON.stringify(b) ? a.length : -1
    }, { timeout: 90_000, intervals: [2000] })
    .toBe(initialInks + 3) // existing ink + 2 ink from A + 1 text from B
  expect(await typeCount(A, 'ink')).toBe(initialInks + 2)
  expect(await typeCount(A, 'text')).toBe(1)
  expect(await typeCount(B, 'ink')).toBe(initialInks + 2)

  // the merged state was persisted locally on B (survives a reload, even without the network)
  const merged = await objectIds(B)
  // an offline reload needs the service worker to control the page
  await expect.poll(() => B.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true)
  await ctxB.setOffline(true)
  await B.reload()
  await expect.poll(() => B.evaluate(() => !!(window as any).__folio?.editor)).toBe(true)
  expect(await objectIds(B)).toEqual(merged)
  await ctxB.setOffline(false)
})

test('no unexpected console errors on either device', async () => {
  const relevant = problems.filter((p) => !/ERR_INTERNET_DISCONNECTED|ERR_FAILED|Failed to load resource|Failed to fetch/.test(p))
  expect(relevant).toEqual([])
})
