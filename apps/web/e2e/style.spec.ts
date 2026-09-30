import { expect, test, type Page } from '@playwright/test'
import { drawStroke, hostBox, newNotebook, nonBackgroundPixels, objectsOf } from './helpers'

/** Properties panel, colour picker, canvas colour schemes, dynamic background and zen mode (fresh profile per test). */

const selectAll = (page: Page) => page.evaluate(() => (window as any).__folio.editor.selectAll())
const collectProblems = (page: Page) => {
  const problems: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()) })
  page.on('pageerror', (e) => problems.push(e.message))
  return problems
}

/** Count screenshot pixels for which `pred` (evaluated in the page on r,g,b) holds. */
async function countPixels(page: Page, clip: { x: number; y: number; width: number; height: number }, pred: string): Promise<number> {
  const png = await page.screenshot({ clip })
  return page.evaluate(async ({ b64, pred }) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const f = new Function('r', 'g', 'b', `return ${pred}`) as (r: number, g: number, b: number) => boolean
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (f(d[i], d[i + 1], d[i + 2])) n++
    return n
  }, { b64: png.toString('base64'), pred })
}

test.describe('properties panel', () => {
  test('stroke colour via quick swatch and hex picker persists across reload; defaults apply to new shapes', async ({ page }) => {
    await newNotebook(page, 'Props')
    await page.getByTestId('tool-shape').click()
    await page.getByTestId('shape-rectangle').click()
    await drawStroke(page, [[500, 300], [560, 340], [660, 420]])
    await expect.poll(async () => (await objectsOf(page, 'shape')).length).toBe(1)

    await page.getByTestId('tool-select').click()
    await selectAll(page)
    await expect(page.getByTestId('properties-panel')).toBeVisible()
    await page.getByLabel('Stroke #e03131').click()
    await expect.poll(async () => (await objectsOf(page, 'shape'))[0].style.strokeColor).toBe('#e03131')

    await page.getByTestId('stroke-color-btn').click()
    await expect(page.getByTestId('color-picker')).toBeVisible()
    await page.getByTestId('hex-input').fill('12ab34')
    await page.getByTestId('hex-input').press('Enter')
    await expect.poll(async () => (await objectsOf(page, 'shape'))[0].style.strokeColor).toBe('#12ab34')
    // keyboard shortcut in the open picker: "x" = teal
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('color-picker')).toHaveCount(0)

    // background + fill + width + style
    await page.getByLabel('Background #ffc9c9').click()
    await expect(page.getByTestId('sec-fillStyle')).toBeVisible()
    await page.getByTestId('fill-style-solid').click()
    await page.getByTestId('stroke-width-4').click()
    await page.getByTestId('stroke-style-dashed').click()
    await expect.poll(async () => {
      const s = (await objectsOf(page, 'shape'))[0].style
      return [s.fillColor, s.fillStyle, s.strokeWidth, s.strokeStyle].join()
    }).toBe('#ffc9c9,solid,4,dashed')

    // wait for the debounced non-undoable settings save, then reload
    await page.waitForTimeout(1200)
    await page.reload()
    await expect.poll(() => page.evaluate(() => !!(window as any).__folio?.editor)).toBe(true)
    expect((await objectsOf(page, 'shape'))[0].style.strokeColor).toBe('#12ab34')
    // the item style default was restored with the notebook
    expect(await page.evaluate(() => (window as any).__folio.editor.itemStyle.strokeColor)).toBe('#12ab34')
    await page.getByTestId('tool-shape').click()
    await drawStroke(page, [[700, 500], [760, 540], [820, 580]]) // clear of the left-hand properties panel
    await expect.poll(async () => (await objectsOf(page, 'shape')).length).toBe(2)
    expect((await objectsOf(page, 'shape'))[1].style.strokeColor).toBe('#12ab34')
  })

  test('font size of a text element', async ({ page }) => {
    await newNotebook(page, 'Text props')
    await page.getByTestId('tool-text').click()
    const b = await hostBox(page)
    await page.mouse.click(b.x + 300, b.y + 300)
    await page.keyboard.type('Hello style')
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await objectsOf(page, 'text')).length).toBe(1)
    await page.getByTestId('tool-select').click()
    await selectAll(page)
    await expect(page.getByTestId('sec-fontSize')).toBeVisible()
    await page.getByTestId('font-size-36').click()
    await expect.poll(async () => (await objectsOf(page, 'text'))[0].fontSize).toBe(36)
    await page.getByTestId('font-family-btn').click()
    await page.getByTestId('font-family-mono').click()
    await expect.poll(async () => (await objectsOf(page, 'text'))[0].fontFamily).toBe('mono')
    await page.getByTestId('text-align-center').click()
    await expect.poll(async () => (await objectsOf(page, 'text'))[0].align).toBe('center')
    // layers row and actions exist for selections
    await expect(page.getByTestId('layer-front')).toBeVisible()
    await expect(page.getByTestId('delete-selection')).toBeVisible()
  })

  test('curved arrow renders off the straight line', async ({ page }) => {
    await newNotebook(page, 'Curved')
    await page.getByTestId('tool-arrow').click()
    await page.getByTestId('arrow-type-curved').click()
    await drawStroke(page, [[400, 400], [500, 400], [700, 400]])
    await expect.poll(async () => (await objectsOf(page, 'arrow')).length).toBe(1)
    const arrow = (await objectsOf(page, 'arrow'))[0]
    expect(arrow.arrowType).toBe('curved')
    await page.waitForTimeout(400)
    const b = await hostBox(page)
    // the straight chord's midpoint must be empty (the curve bulges away), but ink exists overall
    const mid = await countPixels(page, { x: b.x + 545, y: b.y + 395, width: 10, height: 10 }, 'r < 120 && g < 120 && b < 120')
    expect(mid).toBe(0)
    expect(await nonBackgroundPixels(page, { x: b.x + 390, y: b.y + 250, width: 330, height: 300 })).toBeGreaterThan(80)
  })
})

test.describe('canvas colour schemes and backgrounds', () => {
  test('default black ink renders light on a dark page (stored colour stays canonical)', async ({ page }) => {
    await newNotebook(page, 'Dark page')
    await page.getByTestId('open-pages').click()
    await page.getByTestId('paper-#121212').click()
    await page.getByRole('button', { name: 'Close' }).click().catch(() => {})
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => { const f = (window as any).__folio; return f.doc.page(f.editor.pageId).background.color })).toBe('#121212')
    await page.getByTestId('tool-pen').click()
    await drawStroke(page, [[300, 400], [400, 380], [500, 420], [600, 380]], 12)
    await expect.poll(async () => (await objectsOf(page, 'ink')).length).toBe(1)
    expect((await objectsOf(page, 'ink'))[0].style.color).toBe('#1e1e1e')
    await page.waitForTimeout(400)
    const b = await hostBox(page)
    const clip = { x: b.x + 280, y: b.y + 340, width: 360, height: 120 }
    expect(await countPixels(page, clip, 'r > 170 && g > 170 && b > 170')).toBeGreaterThan(150)
    // and nothing dark-on-dark is left behind
    expect(await countPixels(page, clip, 'r > 20 && r < 60 && g > 20 && g < 60 && b > 20 && b < 60')).toBeLessThan(50)
  })

  test('dynamic scaling toggles and zooming does not error', async ({ page }) => {
    const problems = collectProblems(page)
    await newNotebook(page, 'Dynamic bg')
    await page.getByTestId('open-pages').click()
    await page.getByTestId('bg-grid').click()
    await page.getByTestId('bg-scaling-dynamic').click()
    await expect(page.getByText('Dynamic: grid adapts to zoom')).toBeVisible()
    await page.getByTestId('bg-sub-4').click()
    await page.getByTestId('bg-major-5').click()
    await expect.poll(() => page.evaluate(() => { const f = (window as any).__folio; const bg = f.doc.page(f.editor.pageId).background; return [bg.pattern, bg.scaling, bg.subdivisions, bg.majorEvery].join() })).toBe('grid,dynamic,4,5')
    await page.getByTestId('bg-scaling-fixed').click()
    await expect.poll(() => page.evaluate(() => { const f = (window as any).__folio; return f.doc.page(f.editor.pageId).background.scaling })).toBe('fixed')
    await page.getByTestId('bg-scaling-dynamic').click()
    for (const z of [0.05, 0.2, 1, 3, 12]) {
      await page.evaluate((zoom) => { const e = (window as any).__folio.editor; e.setCamera({ x: 0, y: 0, zoom }) }, z)
      await page.waitForTimeout(60)
    }
    expect(problems).toEqual([])
  })
})

test.describe('zen mode', () => {
  test('Alt+Z hides the chrome, keeps a tool strip and restores', async ({ page }) => {
    await newNotebook(page, 'Zen')
    await expect(page.getByTestId('main-menu')).toBeVisible()
    await page.keyboard.press('Alt+z')
    await expect(page.getByTestId('main-menu')).toHaveCount(0)
    await expect(page.getByTestId('zoom-pct')).toHaveCount(0)
    await expect(page.getByTestId('open-pages')).toHaveCount(0)
    await expect(page.getByTestId('zen-exit')).toBeVisible()
    await expect(page.getByTestId('tool-pen')).toBeVisible()
    await expect(page.getByTestId('tool-shape')).toHaveCount(0)
    await expect(page.getByTestId('props-quick')).toBeVisible() // ink tools keep the quick colour bar
    // still draws; the strip fades after drawing and wakes on hover
    await drawStroke(page, [[400, 400], [500, 450], [600, 400]], 8)
    await expect.poll(async () => (await objectsOf(page, 'ink')).length).toBe(1)
    await expect.poll(() => page.getByTestId('toolbar').evaluate((el) => getComputedStyle(el).opacity), { timeout: 6000 }).toBe('0.18')
    await page.getByTestId('toolbar').hover()
    await expect.poll(() => page.getByTestId('toolbar').evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    // selecting shows the compact panel
    await page.getByTestId('tool-select').click()
    await selectAll(page)
    await expect(page.getByTestId('properties-panel')).toBeVisible()
    await page.keyboard.press('Alt+z')
    await expect(page.getByTestId('main-menu')).toBeVisible()
    await expect(page.getByTestId('zen-exit')).toHaveCount(0)
    // persisted setting: exit pill also works
    await page.getByTestId('main-menu').click()
    await page.getByRole('menuitem', { name: 'Zen mode' }).click()
    await expect(page.getByTestId('zen-exit')).toBeVisible()
    await page.getByTestId('zen-exit').click()
    await expect(page.getByTestId('main-menu')).toBeVisible()
  })
})
