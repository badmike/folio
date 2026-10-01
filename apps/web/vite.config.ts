import vue from '@vitejs/plugin-vue'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { TESSERACT_ASSETS } from '../../packages/recognition/src/assets'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Resolve the Tesseract worker/core/language files. Under pnpm `tesseract.js-core` is a
 * dependency of `tesseract.js` only, so it has to be resolved starting from that package.
 */
function resolveTesseractAsset(a: (typeof TESSERACT_ASSETS)[number]): string {
  const recognitionPkg = path.resolve(here, '../../packages/recognition/package.json')
  const fromRecognition = createRequire(recognitionPkg)
  const tessDir = path.dirname(fromRecognition.resolve('tesseract.js/package.json'))
  const req = a.resolveFrom === 'recognition' ? fromRecognition : createRequire(path.join(tessDir, 'package.json'))
  const parts = a.from.split('/')
  const pkgLen = a.from.startsWith('@') ? 2 : 1
  const pkg = parts.slice(0, pkgLen).join('/')
  const rest = parts.slice(pkgLen)
  return path.join(path.dirname(req.resolve(`${pkg}/package.json`)), ...rest)
}

/**
 * loro-crdt's default "browser" build loads its wasm with a *synchronous XHR* at import time. Service
 * workers do not intercept that, so the app would not boot offline. The base64 build embeds the wasm in
 * the JS bundle instead (precached like any other script, no extra request, works offline).
 */
const loroBase64 = createRequire(path.resolve(here, '../../packages/document/package.json')).resolve('loro-crdt/base64')

const tesseractTargets = TESSERACT_ASSETS.map((a) => ({
  src: resolveTesseractAsset(a).replace(/\\/g, '/'),
  dest: path.posix.join('tesseract', path.posix.dirname(a.to)).replace(/\/\.$/, ''),
}))

export default defineConfig({
  plugins: [
    vue(),
    viteStaticCopy({ targets: tesseractTargets }),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // registered from src/services/pwa.ts
      manifest: {
        name: 'folio',
        short_name: 'folio',
        id: 'com.coderscantina.folio',
        description: 'An offline-first notebook for handwriting, diagrams and ideas.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // installed: no browser chrome at all where the platform allows it
        display_override: ['fullscreen', 'standalone'],
        orientation: 'any',
        background_color: '#f6f6f8',
        theme_color: '#f6f6f8',
        categories: ['productivity', 'education'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,wasm,woff2,traineddata,gz,webmanifest}'],
        // Recognition cores (~4 MB each) and sqlite wasm must be precached for offline use.
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: { alias: { 'loro-crdt': loroBase64 } },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
  server: {
    proxy: { '/api': { target: 'http://localhost:8989', changeOrigin: true } },
  },
  preview: { port: 4173 },
})
