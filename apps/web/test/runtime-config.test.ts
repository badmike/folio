import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function load(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl))
  const mod = await import('../src/services/runtime-config')
  await mod.loadRuntimeConfig()
  return mod.runtimeConfig
}

const json = (body: unknown) => async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('runtime config', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('applies config.json and keeps it for offline boots', async () => {
    expect(await load(json({ apiBase: '/api/', clerkPublishableKey: 'pk_test_x' }))).toEqual({ apiBase: '/api', clerkPublishableKey: 'pk_test_x' })

    vi.resetModules()
    const offline = await load(async () => { throw new TypeError('Failed to fetch') })
    expect(offline).toEqual({ apiBase: '/api', clerkPublishableKey: 'pk_test_x' })
  })

  it('keeps the build-time values when the host has no config.json', async () => {
    localStorage.setItem('folio.runtimeConfig', JSON.stringify({ apiBase: '/old', clerkPublishableKey: '' }))
    const cfg = await load(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }))
    expect(cfg).toEqual({ apiBase: '', clerkPublishableKey: '' })
    expect(localStorage.getItem('folio.runtimeConfig')).toBeNull()
  })
})
