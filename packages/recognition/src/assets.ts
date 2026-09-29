/**
 * Files the web app must serve (same origin, so it works offline) for Tesseract.
 *
 * `from` is a module specifier path resolvable from THIS package (packages/recognition),
 * i.e. `require.resolve`-able / relative to its node_modules (pnpm layout: the real files
 * live under node_modules/.pnpm/...; resolve via `createRequire(<recognition pkg>/package.json)`
 * for `tesseract.js/dist/worker.min.js` and via `createRequire(<tesseract.js dir>/package.json)`
 * for `tesseract.js-core/...`, which is a dependency of tesseract.js, not of this package).
 * `to` is the path relative to the configured `tesseractBaseUrl` (default '/tesseract/'), i.e.
 * with the default base the worker is served at `/tesseract/worker.min.js`.
 *
 * Only LSTM builds are needed (OEM LSTM_ONLY): three core variants (Tesseract.js picks the best
 * one at runtime: relaxed-SIMD > SIMD > plain WASM). Each `.wasm.js` embeds its wasm binary.
 * Language data: the `4.0.0_best_int` LSTM-only models (eng ~3 MB, deu ~1.3 MB gz) - the
 * smallest set that Tesseract.js uses when `lstmOnly`; served gzipped as `<lang>.traineddata.gz`
 * (Tesseract.js option `gzip: true`, which is its default).
 */
export interface TesseractAsset {
  /** Module-style path, resolvable from the recognition package (see above). */
  from: string
  /** Path relative to `tesseractBaseUrl`. */
  to: string
  /** Which package's node_modules it resolves from. */
  resolveFrom: 'recognition' | 'tesseract.js'
}

export const TESSERACT_ASSETS: readonly TesseractAsset[] = [
  { from: 'tesseract.js/dist/worker.min.js', to: 'worker.min.js', resolveFrom: 'recognition' },
  { from: 'tesseract.js-core/tesseract-core-lstm.wasm.js', to: 'core/tesseract-core-lstm.wasm.js', resolveFrom: 'tesseract.js' },
  { from: 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js', to: 'core/tesseract-core-simd-lstm.wasm.js', resolveFrom: 'tesseract.js' },
  { from: 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', to: 'core/tesseract-core-relaxedsimd-lstm.wasm.js', resolveFrom: 'tesseract.js' },
  { from: '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', to: 'lang/eng.traineddata.gz', resolveFrom: 'recognition' },
  { from: '@tesseract.js-data/deu/4.0.0_best_int/deu.traineddata.gz', to: 'lang/deu.traineddata.gz', resolveFrom: 'recognition' },
]

export interface TesseractPaths {
  workerPath: string
  corePath: string
  langPath: string
}

/** Derive the three Tesseract path options from a base URL (default '/tesseract/'). */
export function tesseractPaths(baseUrl = '/tesseract/'): TesseractPaths {
  const b = baseUrl.replace(/\/+$/, '')
  return { workerPath: `${b}/worker.min.js`, corePath: `${b}/core`, langPath: `${b}/lang` }
}
