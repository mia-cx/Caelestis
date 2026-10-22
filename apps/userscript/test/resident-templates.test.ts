import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'

/** 4096 × 4096: four of these fill the 64M-pixel memory budget, so a fifth must evict. */
const EDGE = 4096

/** Filling the real budget stores 80M pixels; CI runners take several times longer than a laptop. */
const FILL_BUDGET_TIMEOUT_MS = 30_000

/** A large, nearly transparent template whose one painted pixel identifies it. */
const large = (id: string, paint: number) => {
  const indices = new Uint8Array(EDGE * EDGE).fill(TRANSPARENT_INDEX)
  indices[0] = paint
  return {
    id,
    name: id,
    source: 'image' as const,
    originX: 0,
    originY: 0,
    width: EDGE,
    height: EDGE,
    indices,
    moved: 0,
    opaque: 1,
  }
}

describe('resident templates', () => {
  it('evicts the least recently used template for a new one, and reloads it from IndexedDB', async () => {
    vi.resetModules()
    const store = await import('../src/templates/local-store.js')
    const ids = [1, 2, 3, 4, 5].map((paint) => `resident-${paint}-${crypto.randomUUID()}`)
    try {
      for (const [at, id] of ids.entries()) {
        await store.addLocalTemplate(large(id, at + 1), undefined, true)
      }
      const oldest = store.templateById(ids[0] as string)
      if (oldest === undefined) throw new Error('the oldest template left the catalog')
      expect(oldest.artwork.indices).toBeNull()
      expect(store.templateIndexMemoryBytes()).toBeLessThanOrEqual(64 * 1024 * 1024)

      expect((await store.templatePixels(oldest))[0]).toBe(1)
      expect(store.templateById(ids[1] as string)?.artwork.indices).toBeNull()
    } finally {
      for (const id of ids) await store.removeLocalTemplate(id)
    }
  }, FILL_BUDGET_TIMEOUT_MS)

  it('reloads an evicted server template from its disk copy without downloading it', async () => {
    vi.resetModules()
    const store = await import('../src/templates/local-store.js')
    const serverId = `srv:resident:${crypto.randomUUID()}`
    const ids = [2, 3, 4, 5].map((paint) => `resident-${paint}-${crypto.randomUUID()}`)
    try {
      await store.putServerTemplate({
        ...large(serverId, 1),
        serverUrl: 'https://resident.example',
        serverTemplateId: 'art',
        serverNodeId: null,
        serverVersion: 'v1',
        serverTileKeys: ['0/0'],
      })
      for (const [at, id] of ids.entries()) {
        await store.addLocalTemplate(large(id, at + 2), undefined, true)
      }
      const server = store.templateById(serverId)
      if (server === undefined) throw new Error('the server template left the catalog')
      expect(server.artwork.indices).toBeNull()
      // The test network refuses every request, so these pixels can only come from disk.
      expect((await store.templatePixels(server))[0]).toBe(1)
    } finally {
      await store.forgetServerTemplate(serverId)
      for (const id of ids) await store.removeLocalTemplate(id)
    }
  }, FILL_BUDGET_TIMEOUT_MS)

  it('restores more templates than the old 64-template cap', async () => {
    vi.resetModules()
    const store = await import('../src/templates/local-store.js')
    const ids = Array.from({ length: 65 }, (_, at) => `catalog-${at}-${crypto.randomUUID()}`)
    for (const id of ids) {
      await store.addLocalTemplate(
        {
          id,
          name: id,
          source: 'image',
          originX: 0,
          originY: 0,
          width: 1,
          height: 1,
          indices: new Uint8Array([1]),
          moved: 0,
          opaque: 1,
        },
        undefined,
        true,
      )
    }
    vi.resetModules()
    const restored = await import('../src/templates/local-store.js')
    try {
      await restored.restoreLocalTemplates()
      expect(ids.filter((id) => restored.templateById(id) !== undefined)).toHaveLength(65)
    } finally {
      for (const id of ids) await restored.removeLocalTemplate(id)
    }
  })
})

describe('server pixels and unpublishing', () => {
  it('does not save a download that finishes after its template was unpublished', async () => {
    vi.resetModules()
    const store = await import('../src/templates/local-store.js')
    const { cachedServerOpaque } = await import('../src/templates/server-pixel-cache.js')
    const id = `srv:draft:${crypto.randomUUID()}`
    let finish: ((indices: Uint8Array) => void) | undefined
    store.setServerPixelSource(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    try {
      // Public, with no disk copy yet, so the next read downloads.
      await store.putServerTemplate({
        ...large(id, 1),
        width: 1,
        height: 1,
        indices: null,
        serverUrl: 'https://draft.example',
        serverTemplateId: 'art',
        serverNodeId: null,
        serverVersion: 'v1',
        serverTileKeys: ['0/0'],
      })
      const template = store.templateById(id)
      if (template === undefined) throw new Error('the server template was not installed')
      const loading = store.templatePixels(template)
      await vi.waitFor(() => expect(finish).not.toBe(undefined))

      expect(await store.updateServerTemplateMetadata(id, id, null, true)).toBe(true)
      finish?.(new Uint8Array([1]))
      await loading
      // The save was queued behind the unpublish; give it the chance to run.
      await store.updateServerTemplateMetadata(id, id, null, true)
      expect(await cachedServerOpaque(id, 'v1')).toBeNull()
    } finally {
      await store.forgetServerTemplate(id)
    }
  })
})
