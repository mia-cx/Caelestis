import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import type { ServerConnection } from '../src/settings.js'
import { PIXEL_CHUNK_SIZE } from '../src/templates/sparse-pixels.js'

/** A server copy's fields, from a server this test never connects. */
const copyOf = (url: string) => ({
  origin: 'server' as const,
  server: {
    url,
    isAdmin: false,
    token: null,
    status: 'connected',
    info: null,
    season: 1,
  } satisfies ServerConnection,
  serverTemplateId: 'art',
  nodeId: null,
  version: 'v1',
  unpublished: false,
  wrapX: false,
  tileKeys: ['0/0'],
})

/** 4096 × 4096: four of these fill the 64M-pixel memory budget, so a fifth must evict. */
const EDGE = 4096

/** Filling the real budget stores 80M pixels; CI runners take several times longer than a laptop. */
const FILL_BUDGET_TIMEOUT_MS = 30_000

/**
 * A large template painted in one colour that identifies it, one pixel in every 1000-pixel chunk,
 * so every chunk is stored and it costs its whole area.
 */
const large = (id: string, paint: number) => {
  const indices = new Uint8Array(EDGE * EDGE).fill(TRANSPARENT_INDEX)
  let opaque = 0
  for (let y = 0; y < EDGE; y += PIXEL_CHUNK_SIZE) {
    for (let x = 0; x < EDGE; x += PIXEL_CHUNK_SIZE) {
      indices[y * EDGE + x] = paint
      opaque++
    }
  }
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
    opaque,
  }
}

describe('resident templates', () => {
  it(
    'evicts the least recently used template for a new one, and reloads it from IndexedDB',
    async () => {
      vi.resetModules()
      const catalog = await import('../src/templates/catalog.js')
      const residency = await import('../src/templates/residency.js')
      const edits = await import('../src/templates/template-edits.js')
      const ids = [1, 2, 3, 4, 5].map((paint) => `resident-${paint}-${crypto.randomUUID()}`)
      try {
        for (const [at, id] of ids.entries()) {
          await edits.addLocalTemplate(large(id, at + 1), undefined, true)
        }
        const oldest = catalog.templateById(ids[0] as string)
        if (oldest === undefined) throw new Error('the oldest template left the catalog')
        expect(oldest.artwork.pixels).toBeNull()
        expect(residency.templateIndexMemoryBytes()).toBeLessThanOrEqual(64 * 1024 * 1024)

        expect((await residency.templatePixels(oldest))[0]).toBe(1)
        expect(catalog.templateById(ids[1] as string)?.artwork.pixels).toBeNull()
      } finally {
        for (const id of ids) await edits.removeLocalTemplate(id)
      }
    },
    FILL_BUDGET_TIMEOUT_MS,
  )

  it(
    'reloads an evicted server template from its disk copy without downloading it',
    async () => {
      vi.resetModules()
      const catalog = await import('../src/templates/catalog.js')
      const residency = await import('../src/templates/residency.js')
      const copies = await import('../src/templates/template-copies.js')
      const edits = await import('../src/templates/template-edits.js')
      const serverId = `srv:resident:${crypto.randomUUID()}`
      const ids = [2, 3, 4, 5].map((paint) => `resident-${paint}-${crypto.randomUUID()}`)
      try {
        await copies.putTemplateCopy({
          ...large(serverId, 1),
          ...copyOf('https://resident.example'),
        })
        for (const [at, id] of ids.entries()) {
          await edits.addLocalTemplate(large(id, at + 2), undefined, true)
        }
        const server = catalog.templateById(serverId)
        if (server === undefined) throw new Error('the server template left the catalog')
        expect(server.artwork.pixels).toBeNull()
        // The test network refuses every request, so these pixels can only come from disk.
        expect((await residency.templatePixels(server))[0]).toBe(1)
      } finally {
        await copies.forgetTemplateCopy(serverId)
        for (const id of ids) await edits.removeLocalTemplate(id)
      }
    },
    FILL_BUDGET_TIMEOUT_MS,
  )

  it('restores more templates than the old 64-template cap', async () => {
    vi.resetModules()
    const edits = await import('../src/templates/template-edits.js')
    const ids = Array.from({ length: 65 }, (_, at) => `catalog-${at}-${crypto.randomUUID()}`)
    for (const id of ids) {
      await edits.addLocalTemplate(
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
    const restoredCatalog = await import('../src/templates/catalog.js')
    const restoredRestore = await import('../src/templates/restore.js')
    const restoredEdits = await import('../src/templates/template-edits.js')
    try {
      await restoredRestore.restoreLocalTemplates()
      expect(ids.filter((id) => restoredCatalog.templateById(id) !== undefined)).toHaveLength(65)
    } finally {
      for (const id of ids) await restoredEdits.removeLocalTemplate(id)
    }
  })

  it(
    'keeps sparse templates side by side, each costing only its painted chunk',
    async () => {
      vi.resetModules()
      const catalog = await import('../src/templates/catalog.js')
      const residency = await import('../src/templates/residency.js')
      const edits = await import('../src/templates/template-edits.js')
      // Five boxes this size fill more than the budget, but each paints a single pixel.
      const ids = [1, 2, 3, 4, 5].map((paint) => `sparse-${paint}-${crypto.randomUUID()}`)
      const painted = 2048 * EDGE + 2048
      try {
        for (const [at, id] of ids.entries()) {
          const template = large(id, at + 1)
          template.indices.fill(TRANSPARENT_INDEX)
          template.indices[painted] = at + 1
          await edits.addLocalTemplate({ ...template, opaque: 1 }, undefined, true)
        }
        const held = ids.map((id) => catalog.templateById(id)?.artwork.pixels)
        expect(held.every((pixels) => pixels != null)).toBe(true)
        expect(residency.templateIndexMemoryBytes()).toBe(ids.length * PIXEL_CHUNK_SIZE ** 2)

        vi.resetModules()
        const restoredCatalog = await import('../src/templates/catalog.js')
        const restoredResidency = await import('../src/templates/residency.js')
        const restoredRestore = await import('../src/templates/restore.js')
        await restoredRestore.restoreLocalTemplates()
        const first = restoredCatalog.templateById(ids[0] as string)
        if (first === undefined) throw new Error('the template did not restore')
        expect((await restoredResidency.templatePixels(first))[painted]).toBe(1)
      } finally {
        for (const id of ids) await edits.removeLocalTemplate(id)
      }
    },
    FILL_BUDGET_TIMEOUT_MS,
  )
})

describe('server pixels and unpublishing', () => {
  it('does not save a download that finishes after its template was unpublished', async () => {
    vi.resetModules()
    const catalog = await import('../src/templates/catalog.js')
    const residency = await import('../src/templates/residency.js')
    const copies = await import('../src/templates/template-copies.js')
    const { cachedServerCopy } = await import('../src/templates/server-pixel-cache.js')
    const id = `srv:draft:${crypto.randomUUID()}`
    let finish: ((indices: Uint8Array) => void) | undefined
    copies.setServerPixelSource(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    try {
      // Public, with no disk copy yet, so the next read downloads.
      await copies.putTemplateCopy({
        ...large(id, 1),
        width: 1,
        height: 1,
        indices: null,
        ...copyOf('https://draft.example'),
      })
      const template = catalog.templateById(id)
      if (template?.origin !== 'server') throw new Error('the server template was not installed')
      const loading = residency.templatePixels(template)
      await vi.waitFor(() => expect(finish).not.toBe(undefined))

      expect(await copies.updateServerTemplateMetadata(id, id, null, true, template.server)).toBe(
        true,
      )
      finish?.(new Uint8Array([1]))
      await loading
      // The save was queued behind the unpublish; give it the chance to run.
      await copies.updateServerTemplateMetadata(id, id, null, true, template.server)
      expect(await cachedServerCopy(id, 'v1')).toBeNull()
    } finally {
      await copies.forgetTemplateCopy(id)
    }
  })
})
