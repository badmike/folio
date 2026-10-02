// Generates the app icons, favicon.ico and the social share image from public/icons/icon.svg
// using the Playwright chromium.
// Usage: node scripts/gen-brand-assets.mjs   (PW_CHROMIUM=/path/to/chromium to override)
import { chromium } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = (...p) => join(root, 'public', ...p)
const svg = readFileSync(pub('icons/icon.svg'), 'utf8').replace(/^<\?xml[^>]*\?>/, '')
// Background of icon.svg; padded variants extend it to the full bleed.
const BACKGROUND = '#121212'
const INK = '#fbfaf6'
const exe = process.env.PW_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)
const browser = await chromium.launch({ executablePath: exe })
const page = await browser.newPage()

async function shoot(html, width, height) {
  await page.setViewportSize({ width, height })
  await page.setContent(`<body style="margin:0;background:transparent">${html}</body>`)
  await page.evaluate(() => document.fonts.ready)
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width, height } })
}

/** `scale` < 1 shrinks the glyph into a safe zone (maskable icons: 80%, iOS rounds the corners). */
function icon(size, scale = 1) {
  if (scale === 1) return svg.replace('<svg ', `<svg width="${size}" height="${size}" `)
  const inner = svg.replace(/<svg[^>]*>/, '').replace('</svg>', '')
  const offset = (512 * (1 - scale)) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="${BACKGROUND}"/><g transform="translate(${offset} ${offset}) scale(${scale})">${inner}</g></svg>`
}

async function png(name, size, scale) {
  writeFileSync(pub(name), await shoot(icon(size, scale), size, size))
  console.log('wrote', name)
}

/** ICO container with embedded PNGs (supported by every browser that still asks for /favicon.ico). */
async function ico(name, sizes) {
  const images = []
  for (const s of sizes) images.push(await shoot(icon(s), s, s))
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach((img, i) => {
    const e = 6 + 16 * i
    header.writeUInt8(sizes[i] % 256, e)
    header.writeUInt8(sizes[i] % 256, e + 1)
    header.writeUInt16LE(1, e + 4)
    header.writeUInt16LE(32, e + 6)
    header.writeUInt32LE(img.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += img.length
  })
  writeFileSync(pub(name), Buffer.concat([header, ...images]))
  console.log('wrote', name)
}

/** 1200x630 Open Graph / Twitter card: the wordmark next to a sketch that cleans itself up. */
async function og(name) {
  const font = readFileSync(pub('fonts/Excalifont-Regular.woff2')).toString('base64')
  const logo = readFileSync(pub('logo.svg'), 'utf8').replace('<svg ', `<svg width="300" `).replaceAll(/class="b"|fill="currentColor"/g, `fill="${INK}"`)
  const html = `
  <style>
    @font-face { font-family: Excalifont; src: url(data:font/woff2;base64,${font}) format('woff2'); }
    .card { position: relative; width: 1200px; height: 630px; overflow: hidden; background: ${BACKGROUND};
      background-image: radial-gradient(rgba(251,250,246,.09) 1.5px, transparent 1.5px); background-size: 28px 28px;
      font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: ${INK}; }
    .copy { position: absolute; left: 88px; top: 50%; width: 560px; transform: translateY(-50%); }
    .copy p { margin: 40px 0 0; font-size: 40px; line-height: 1.25; font-weight: 600; letter-spacing: -0.01em; }
    .copy small { display: block; margin-top: 16px; font-size: 22px; font-weight: 400; color: rgba(251,250,246,.6); }
    .sketch { position: absolute; right: 70px; top: 105px; }
    .sketch text { font-family: Excalifont; fill: ${INK}; }
  </style>
  <div class="card">
    <div class="copy">
      ${logo}
      <p>Handwriting, diagrams and ideas on an infinite canvas.</p>
      <small>Offline first. Searchable ink. Syncs when you want it to.</small>
    </div>
    <svg class="sketch" width="500" height="440" viewBox="0 0 500 440" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <!-- rough sketch -->
      <path d="M38 52c48-6 112-4 160 1M36 50c-3 30 0 62 3 92M198 50c4 30 3 64 1 95M40 144c50 3 108 2 158-1" stroke="${INK}" stroke-width="4"/>
      <path d="M45 58c46-3 104-1 148 3M42 56c2 28 1 58 4 84M193 60c2 26 2 56 0 80" stroke="${INK}" stroke-width="2" opacity=".45"/>
      <text x="62" y="108" font-size="34">my idea</text>
      <!-- arrow -->
      <path d="M210 100c50-6 92 20 118 70" stroke="#4dabf7" stroke-width="4"/>
      <path d="M306 160l23 13 1-27" stroke="#4dabf7" stroke-width="4"/>
      <text x="240" y="82" font-size="26" style="fill:#4dabf7">clean up</text>
      <!-- tidy diagram -->
      <rect x="250" y="196" width="200" height="96" rx="14" stroke="${INK}" stroke-width="4" fill="rgba(77,171,247,.12)"/>
      <text x="292" y="254" font-size="32">Diagram</text>
      <path d="M350 292v56" stroke="${INK}" stroke-width="4"/>
      <path d="M338 336l12 14 12-14" stroke="${INK}" stroke-width="4"/>
      <ellipse cx="350" cy="392" rx="96" ry="36" stroke="#ffd43b" stroke-width="4" fill="rgba(255,212,59,.12)"/>
      <text x="300" y="402" font-size="28">shipped!</text>
    </svg>
  </div>`
  writeFileSync(pub(name), await shoot(html, 1200, 630))
  console.log('wrote', name)
}

await png('icons/icon-192.png', 192)
await png('icons/icon-512.png', 512)
await png('icons/icon-maskable-192.png', 192, 0.7)
await png('icons/icon-maskable-512.png', 512, 0.7)
// iOS masks the icon to a rounded square; keep the glyph clear of the corners.
await png('apple-touch-icon.png', 180, 0.82)
await ico('favicon.ico', [16, 32, 48])
await og('og-image.png')
await browser.close()
