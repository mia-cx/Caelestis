import { TILE_SIZE, TRANSPARENT_INDEX } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureRegion, templateFromCapture } from '../src/templates/capture-region.js'
import { UNPAINTED } from '../src/tile-transform.js'

const tiles = new Map<string, Uint8Array>()

vi.mock('../src/tile-transform.js', async (original) => ({
  ...(await original<typeof import('../src/tile-transform.js')>()),
  loadCommittedTilePixels: async (tile: { x: number; y: number }) =>
    tiles.get(`${tile.x}/${tile.y}`) ?? null,
}))

const blankTile = (): Uint8Array => new Uint8Array(TILE_SIZE * TILE_SIZE).fill(UNPAINTED)

const paint = (tile: Uint8Array, x: number, y: number, colour: number): void => {
  tile[y * TILE_SIZE + x] = colour
}

/** A `w` by `h` selection at `x`, `y` that keeps every pixel, or only those `keep` names. */
const selection = (
  x: number,
  y: number,
  w: number,
  h: number,
  keep: (column: number, row: number) => boolean = () => true,
) => {
  const mask = new Uint8Array(w * h)
  for (let row = 0; row < h; row++)
    for (let column = 0; column < w; column++) mask[row * w + column] = keep(column, row) ? 1 : 0
  const rect = { x, y, w, h }
  return { rect, parts: [{ rect, mask, count: mask.reduce((sum, bit) => sum + bit, 0) }] }
}

beforeEach(() => {
  tiles.clear()
})

describe('captureRegion', () => {
  it('captures committed colours across a tile boundary, one pixel per world pixel', async () => {
    const west = blankTile()
    const east = blankTile()
    paint(west, TILE_SIZE - 1, 4, 5)
    paint(east, 0, 4, 9)
    tiles.set('0/0', west)
    tiles.set('1/0', east)

    const capture = await captureRegion(selection(TILE_SIZE - 2, 3, 4, 3))

    expect([capture.width, capture.height]).toEqual([4, 3])
    expect([capture.originX, capture.originY]).toEqual([TILE_SIZE - 2, 3])
    expect(capture.opaque).toBe(2)
    const row = Array.from(capture.indices.slice(4, 8))
    expect(row).toEqual([TRANSPARENT_INDEX, 5, 9, TRANSPARENT_INDEX])
  })

  it('leaves out pixels outside the selection shape', async () => {
    const tile = blankTile()
    paint(tile, 0, 0, 5)
    paint(tile, 1, 0, 6)
    tiles.set('0/0', tile)

    const capture = await captureRegion(selection(0, 0, 2, 1, (column) => column === 1))

    expect(Array.from(capture.indices)).toEqual([TRANSPARENT_INDEX, 6])
    expect(capture.opaque).toBe(1)
  })

  it('is a snapshot: later canvas changes and the source tile stay separate', async () => {
    const tile = blankTile()
    paint(tile, 0, 0, 5)
    tiles.set('0/0', tile)

    const capture = await captureRegion(selection(0, 0, 1, 1))
    paint(tile, 0, 0, 7)

    expect(Array.from(capture.indices)).toEqual([5])
    expect(tile[0]).toBe(7)
  })

  it('refuses to treat a tile that has not loaded as transparent', async () => {
    tiles.set('0/0', blankTile())

    await expect(captureRegion(selection(TILE_SIZE - 1, 0, 2, 1))).rejects.toThrow(
      /committed Wplace tile 1\/0/,
    )
  })

  it('refuses a selection with no artwork in it', async () => {
    tiles.set('0/0', blankTile())

    await expect(captureRegion(selection(0, 0, 3, 3))).rejects.toThrow(/no artwork/)
  })
})

describe('templateFromCapture', () => {
  it('starts a new image template where the art was captured', async () => {
    const tile = blankTile()
    paint(tile, 2, 3, 5)
    tiles.set('0/0', tile)

    const template = templateFromCapture(await captureRegion(selection(1, 2, 3, 3)))

    expect(template).toMatchObject({
      source: 'image',
      originX: 1,
      originY: 2,
      width: 3,
      height: 3,
      opaque: 1,
    })
    expect(template.indices[1 * 3 + 1]).toBe(5)
  })
})
