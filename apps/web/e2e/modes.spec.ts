import { expect, test, type Page } from '@playwright/test'
import { countType, drawStroke, hostBox, inkCount, newNotebook, openSettings } from './helpers'

/** Cleanup modes ('keep' / 'auto') and restyling the selection, each on a fresh profile. */

async function setCleanupMode(page: Page, label: 'Keep my ink' | 'Ask' | 'Automatic') {
  await openSettings(page, 'Handwriting')
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.keyboard.press('Escape')
}

const rect = (x: number, y: number): [number, number][] => [[x, y], [x + 150, y + 2], [x + 152, y + 100], [x + 2, y + 102], [x, y + 3]]

test.describe('cleanup modes', () => {
  test('keep: ink is never converted, even after a long pause', async ({ page }) => {
    await newNotebook(page, 'Keep mode')
    await setCleanupMode(page, 'Keep my ink')
    await drawStroke(page, rect(600, 300), 30)
    await expect.poll(() => inkCount(page)).toBe(1)
    // wait well beyond the idle delay (2.5 s) plus recognition time
    await page.waitForTimeout(7000)
    expect(await countType(page, 'shape')).toBe(0)
    expect(await inkCount(page)).toBe(1)
    await expect(page.getByTestId('cleanup-prompt')).toHaveCount(0)
  })

  test('auto: converts high-confidence ink after inactivity, never while drawing', async ({ page }) => {
    await newNotebook(page, 'Auto mode')
    await setCleanupMode(page, 'Automatic')
    await drawStroke(page, rect(500, 300), 30)
    // Keep the pointer down (drawing) for longer than the idle delay: nothing may convert meanwhile.
    const b = await hostBox(page)
    await page.mouse.move(b.x + 900, b.y + 500)
    await page.mouse.down()
    await page.mouse.move(b.x + 930, b.y + 520, { steps: 5 })
    await page.waitForTimeout(6000)
    expect(await countType(page, 'shape')).toBe(0)
    expect(await inkCount(page)).toBe(1) // the live stroke is not committed yet
    await page.mouse.up()
    // after the pen is up and the user is inactive, the rectangle is converted automatically
    await expect.poll(() => countType(page, 'shape'), { timeout: 30_000 }).toBe(1)
    const shape = await page.evaluate(() => {
      const f = (window as any).__folio
      return f.doc.objects(f.editor.pageId).find((o: any) => o.type === 'shape')?.kind
    })
    expect(shape).toBe('rectangle')
  })
})

test.describe('selection style', () => {
  test('changing colour and width with a selection restyles it as separate undo steps', async ({ page }) => {
    await newNotebook(page, 'Style')
    await drawStroke(page, [[400, 400], [500, 460], [600, 400]], 6)
    await expect.poll(() => inkCount(page)).toBe(1)
    await page.getByTestId('tool-select').click()
    await drawStroke(page, [[350, 350], [650, 520]]) // marquee
    await expect.poll(() => page.evaluate(() => (window as any).__folio.editor.selection.length)).toBe(1)
    await page.getByLabel('Stroke #e03131').click()
    const ink = () => page.evaluate(() => {
      const f = (window as any).__folio
      return f.doc.objects(f.editor.pageId).find((o: any) => o.type === 'ink')?.style
    })
    await expect.poll(async () => (await ink()).color).toBe('#e03131')
    await page.getByTestId('stroke-width-4').click() // bold pen preset
    await expect.poll(async () => (await ink()).width).toBe(4.5)
    await page.evaluate(() => (window as any).__folio.editor.undo())
    await expect.poll(async () => (await ink()).width).not.toBe(4.5)
    await page.evaluate(() => (window as any).__folio.editor.undo())
    await expect.poll(async () => (await ink()).color).not.toBe('#e03131')
  })
})
