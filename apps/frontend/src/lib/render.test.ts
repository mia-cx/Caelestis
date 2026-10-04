import { planTimelapseTiles, tileKey, WORLD_PIXELS } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { template } from '../tests/fixtures'
import { timelapseLayout } from './render'

const at = (id: string, minX: number, minY: number, size = 100) =>
  template({
    id,
    bbox: { minX, minY, maxX: (minX + size) % WORLD_PIXELS, maxY: minY + size },
    chunks: [],
  })

it('places only the tiles the server captures for each template, once each', () => {
  const near = at('near', 10_000, 10_000)
  const overlapping = at('overlapping', 10_050, 10_050)
  const far = at('far', 900_000, 600_000)
  const layout = timelapseLayout([near, overlapping, far])

  const keys = layout.tiles.map((tile) => tile.key)
  expect(new Set(keys).size).toBe(keys.length)
  expect(new Set(keys)).toEqual(
    new Set(planTimelapseTiles([near.bbox, overlapping.bbox, far.bbox]).map(tileKey)),
  )
  expect(layout.tiles.find((tile) => tile.key === '10/10')?.templates).toEqual([near, overlapping])
  // Each placement draws its tile where that tile sits in the world.
  for (const tile of layout.tiles)
    expect(tileKey({ x: tile.x / 1_000, y: tile.y / 1_000 })).toBe(tile.key)
})

it('keeps templates on both sides of the world seam next to each other', () => {
  const west = template({
    id: 'west',
    bbox: { minX: WORLD_PIXELS - 5_000, minY: 0, maxX: WORLD_PIXELS - 4_900, maxY: 100 },
    chunks: [{ tile: '2043/0', hash: 'west' }],
  })
  const east = template({
    id: 'east',
    bbox: { minX: 3_000, minY: 0, maxX: 3_100, maxY: 100 },
    chunks: [{ tile: '3/0', hash: 'east' }],
  })
  const layout = timelapseLayout([east, west])

  expect(layout.bounds.width).toBeLessThan(10_000)
  expect(layout.art).toEqual({ x: WORLD_PIXELS - 5_000, y: 0, width: 8_100, height: 100 })
  expect(layout.chunks).toEqual([
    { hash: 'east', x: WORLD_PIXELS + 3_000, y: 0 },
    { hash: 'west', x: WORLD_PIXELS - 5_000, y: 0 },
  ])
})

it('unrolls a template that crosses the seam without stacking its chunks', () => {
  const layout = timelapseLayout([
    template({
      bbox: { minX: WORLD_PIXELS - 500, minY: 0, maxX: 500, maxY: 100 },
      chunks: [
        { tile: '2047/0', hash: 'left' },
        { tile: '0/0', hash: 'right' },
      ],
    }),
  ])

  expect(layout.chunks).toEqual([
    { hash: 'left', x: WORLD_PIXELS - 500, y: 0 },
    { hash: 'right', x: WORLD_PIXELS, y: 0 },
  ])
  expect(layout.tiles.find((tile) => tile.key === '0/0')?.x).toBe(WORLD_PIXELS)
})

it('draws a tile at both ends when captures span every longitude', () => {
  const band = Array.from({ length: 51 }, (_, index) =>
    template({
      id: `band-${index}`,
      bbox: { minX: 500 + index * 40_000, minY: 0, maxX: 40_500 + index * 40_000, maxY: 1 },
    }),
  )
  const seam = template({
    id: 'seam',
    bbox: { minX: WORLD_PIXELS - 7_500, minY: 0, maxX: 500, maxY: 1 },
  })
  const layout = timelapseLayout([...band, seam])

  const cut = layout.tiles.filter((tile) => tile.key === '0/0')
  expect(cut.map((tile) => tile.x)).toEqual([0, WORLD_PIXELS])
  expect(cut[1]?.templates).toEqual([seam])
})
