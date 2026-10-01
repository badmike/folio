// Generates PNG icons from public/icons/icon.svg using the Playwright chromium.
// Usage: node scripts/gen-icons.mjs   (PW_CHROMIUM=/path/to/chromium to override)
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'public/icons/icon.svg'), 'utf8').replace(/^<\?xml[^>]*\?>/, '')
// Background of icon.svg; the maskable variants extend it to the full bleed.
const BACKGROUND = '#121212'
const exe = process.env.PW_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)
const browser = await chromium.launch({ executablePath: exe })
const page = await browser.newPage()

async function render(size, { maskable = false, name }) {
  // Maskable icons need a full-bleed background and the glyph inside the 80% safe zone.
  const inner = svg.replace(/<svg[^>]*>/, '').replace('</svg>', '')
  const body = maskable
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
         <rect width="512" height="512" fill="${BACKGROUND}"/><g transform="translate(76.8 76.8) scale(0.7)">${inner}</g></svg>`
    : svg.replace('<svg ', `<svg width="${size}" height="${size}" `)
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<body style="margin:0;background:transparent">${body}</body>`)
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
  writeFileSync(join(root, 'public/icons', name), png)
  console.log('wrote', name)
}

await render(192, { name: 'icon-192.png' })
await render(512, { name: 'icon-512.png' })
await render(512, { name: 'icon-maskable-512.png', maskable: true })
// iOS only rounds the corners, so the full-bleed icon is used as is.
await render(180, { name: 'apple-touch-icon.png' })
await browser.close()
