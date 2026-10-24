import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  deleteTemplate,
  loadTemplate,
  type StoredTemplate,
  saveTemplate,
} from '../src/templates/persist.js'
import { cutPixels, joinPixels, PIXEL_CHUNK_SIZE } from '../src/templates/sparse-pixels.js'
import { putRaw, rawRecord } from './template-records.js'

const template = (id: string, name = 'Grid') => ({
  id,
  name,
  source: 'image' as const,
  originX: 12,
  originY: 34,
  width: 2,
  height: 2,
  pixels: cutPixels(2, 2, new Uint8Array([1, 2, 3, 4])),
  moved: 0,
  opaque: 4,
  visible: true,
  everPlaced: true,
  revision: 0,
})

/** 3000 × 2000 with one pixel painted, so one of its six chunks holds anything. */
const SPARSE_WIDTH = 3000
const SPARSE_HEIGHT = 2000
const SPARSE_IMAGE = new Uint8Array(SPARSE_WIDTH * SPARSE_HEIGHT).fill(TRANSPARENT_INDEX)
SPARSE_IMAGE[1500 * SPARSE_WIDTH + 2500] = 7

const sparseTemplate = (id: string) => ({
  ...template(id),
  width: SPARSE_WIDTH,
  height: SPARSE_HEIGHT,
  pixels: cutPixels(SPARSE_WIDTH, SPARSE_HEIGHT, SPARSE_IMAGE),
  opaque: 1,
})

const loadedPixels = async (id: string): Promise<Uint8Array> => {
  const loaded = await loadTemplate(id)
  if (loaded.status !== 'loaded') throw new Error(`template did not load: ${loaded.status}`)
  return joinPixels((loaded.template as StoredTemplate).pixels)
}

/** Byte equality for megapixel arrays, which a deep equality matcher walks too slowly. */
const same = (left: Uint8Array, right: Uint8Array): boolean =>
  Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
    Buffer.from(right.buffer, right.byteOffset, right.byteLength),
  )

const storedBytes = async (id: string): Promise<number> =>
  ((await rawRecord(id))?.indices as Blob | undefined)?.size ?? 0

describe('personal template persistence', () => {
  it('persists pixels and rejects a stale writer without losing the winner', async () => {
    const id = `persistence-${crypto.randomUUID()}`
    const initial = template(id)
    expect(await saveTemplate(initial, null)).toEqual({ status: 'saved', revision: 1 })
    expect(await saveTemplate({ ...initial, name: 'Winner', revision: 1 }, 1)).toEqual({
      status: 'saved',
      revision: 2,
    })
    expect(await saveTemplate({ ...initial, name: 'Stale', revision: 1 }, 1)).toEqual({
      status: 'conflict',
    })
    const loaded = await loadTemplate(id)
    expect(loaded).toMatchObject({ status: 'loaded', template: { name: 'Winner' } })
    expect([...(await loadedPixels(id))]).toEqual([1, 2, 3, 4])
    expect(await deleteTemplate(id, 2)).toEqual({ status: 'saved', revision: 2 })
  })

  it('stores only the chunks with something painted', async () => {
    const id = `persistence-${crypto.randomUUID()}`
    expect(await saveTemplate(sparseTemplate(id), null)).toEqual({ status: 'saved', revision: 1 })
    expect(await storedBytes(id)).toBe(PIXEL_CHUNK_SIZE * PIXEL_CHUNK_SIZE)
    expect(same(await loadedPixels(id), SPARSE_IMAGE)).toBe(true)
    await deleteTemplate(id, 1)
  })

  it('loads a dense record from before chunks, and stores it packed afterwards', async () => {
    const id = `persistence-${crypto.randomUUID()}`
    await saveTemplate(sparseTemplate(id), null)
    const record = await rawRecord(id)
    const { chunks: _chunks, ...dense } = record ?? {}
    await putRaw({ ...dense, indices: new Blob([SPARSE_IMAGE]) })
    expect(await storedBytes(id)).toBe(SPARSE_WIDTH * SPARSE_HEIGHT)

    expect(same(await loadedPixels(id), SPARSE_IMAGE)).toBe(true)
    await vi.waitFor(async () =>
      expect(await storedBytes(id)).toBe(PIXEL_CHUNK_SIZE * PIXEL_CHUNK_SIZE),
    )
    await deleteTemplate(id, 1)
  })
})
