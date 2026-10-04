import { TILE_SIZE, TRANSPARENT_INDEX, WORLD_PIXELS } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureSelectedArtwork, captureTemplateArea } from '../src/templates/current-artwork.js'
import { loadCommittedTilePixels, UNPAINTED } from '../src/tile-transform.js'

vi.mock('../src/tile-transform.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tile-transform.js')>()),
  loadCommittedTilePixels: vi.fn(),
}))

const tiles = new Map<string, Uint8Array>()

const paint = (x: number, y: number, index: number): void => {
  const key = `${Math.floor(x / TILE_SIZE)}/${Math.floor(y / TILE_SIZE)}`
  const tile = tiles.get(key) ?? new Uint8Array(TILE_SIZE * TILE_SIZE).fill(UNPAINTED)
  tile[(y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE)] = index
  tiles.set(key, tile)
}

beforeEach(() => {
  tiles.clear()
  vi.mocked(loadCommittedTilePixels).mockImplementation(
    async (tile) => tiles.get(`${tile.x}/${tile.y}`) ?? null,
  )
})

// Four pixels across the boundary between tiles 0/0 and 1/0, two rows, one corner cut out.
const selection = {
  rect: { x: TILE_SIZE - 2, y: 5, w: 4, h: 2 },
  mask: new Uint8Array([1, 1, 1, 1, 1, 1, 1, 0]),
  count: 7,
}

describe('captureSelectedArtwork', () => {
  it('refuses shapes crossing the world edge instead of wrapping their pixels', async () => {
    await expect(
      captureSelectedArtwork({
        rect: { x: WORLD_PIXELS - 1, y: 0, w: 2, h: 1 },
        mask: new Uint8Array([1, 1]),
        count: 2,
      }),
    ).rejects.toThrow('inside the world canvas')
  })
  it('copies committed art across tiles, keeping unpainted and unselected pixels transparent', async () => {
    paint(TILE_SIZE - 2, 5, 5)
    paint(TILE_SIZE - 1, 5, 9)
    paint(TILE_SIZE + 1, 5, 31)
    paint(TILE_SIZE - 2, 6, 12)
    paint(TILE_SIZE + 1, 6, 20)

    const indices = await captureSelectedArtwork(selection)

    const _ = TRANSPARENT_INDEX
    expect(Array.from(indices)).toEqual([5, 9, _, 31, 12, _, _, _])
  })

  it('fails instead of treating an unloaded tile as transparent', async () => {
    paint(TILE_SIZE - 2, 5, 5)

    await expect(captureSelectedArtwork(selection)).rejects.toThrow(
      'Could not load committed Wplace tile 1/0',
    )
  })

  it('skips a missing tile between two selected regions', async () => {
    const mask = new Uint8Array(TILE_SIZE * 2 + 1)
    mask[0] = 1
    mask[mask.length - 1] = 1
    paint(0, 0, 5)
    paint(TILE_SIZE * 2, 0, 9)

    const indices = await captureSelectedArtwork({
      rect: { x: 0, y: 0, w: mask.length, h: 1 },
      mask,
      count: 2,
    })

    expect(indices[0]).toBe(5)
    expect(indices[TILE_SIZE]).toBe(TRANSPARENT_INDEX)
    expect(indices[indices.length - 1]).toBe(9)
    expect(loadCommittedTilePixels).toHaveBeenCalledTimes(2)
    expect(loadCommittedTilePixels).not.toHaveBeenCalledWith({ x: 1, y: 0 })
  })
})

describe('captureTemplateArea', () => {
  // One row of four target pixels; the last one sits in tile 1/0, which never loads.
  const template = {
    originX: TILE_SIZE - 3,
    originY: 0,
    width: 4,
    height: 1,
    indices: new Uint8Array([1, 2, 3, 4]),
  }

  it('takes painted art inside the selection only, keeping unpainted and unselected targets', async () => {
    paint(TILE_SIZE - 3, 0, 7)
    paint(TILE_SIZE - 1, 0, 9)
    // Selected from left of the template: the first two of its pixels, the second unpainted.
    const indices = await captureTemplateArea(template, {
      rect: { x: TILE_SIZE - 5, y: 0, w: 4, h: 1 },
      mask: new Uint8Array([1, 1, 1, 1]),
      count: 4,
    })

    expect(Array.from(indices)).toEqual([7, 2, 3, 4])
    expect(loadCommittedTilePixels).not.toHaveBeenCalledWith({ x: 1, y: 0 })
  })

  it('refuses a selection that misses the template', async () => {
    await expect(
      captureTemplateArea(template, {
        rect: { x: 0, y: 1, w: 1, h: 1 },
        mask: new Uint8Array([1]),
        count: 1,
      }),
    ).rejects.toThrow('Select part of the template')
  })
})
