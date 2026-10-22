import { canvasPixelToLatLng, PALETTE_RGB } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  localTemplates,
  type PlacedTemplate,
  templateTileKeys,
} from '../src/templates/local-store.js'
import { syncOfficialOverlays } from '../src/templates/official-overlays.js'

const LAYER = 'seven-seals-template-2'

/** The slice of MapLibre and Wplace's seal layer that the mirror reads. */
const fakeMap = () => {
  const layers = new Map<
    string,
    { implementation: { data?: unknown; setData(data: unknown): void } }
  >()
  const visibility = new Map<string, unknown>()
  let styledata = () => {}
  return {
    visibility,
    addLayer(id: string) {
      layers.set(id, {
        implementation: {
          setData(data) {
            this.data = data
          },
        },
      })
      styledata()
    },
    removeLayer(id: string) {
      layers.delete(id)
      styledata()
    },
    layer: (id: string) => layers.get(id)?.implementation,
    getLayersOrder: () => [...layers.keys()],
    getLayer: (id: string) => layers.get(id),
    getLayoutProperty: (id: string) => visibility.get(id),
    setLayoutProperty: (id: string, _name: string, value: unknown) => {
      visibility.set(id, value)
      styledata()
    },
    on: (_type: string, listener: () => void) => {
      styledata = listener
    },
  }
}

const sealArt = () => {
  const data = new Uint8ClampedArray(2 * 2 * 4)
  ;[1, 2, 3, 4].forEach((index, pixel) => {
    data.set([...(PALETTE_RGB[index] as readonly number[]), 255], pixel * 4)
  })
  return { width: 2, height: 2, data }
}

const corner = (x: number, y: number): [number, number] => {
  const { lat, lng } = canvasPixelToLatLng({ x, y })
  return [lng, lat]
}

const mirrors = () =>
  localTemplates().filter((template) => template.serverUrl === 'https://wplace.live')

describe('official overlays', () => {
  it('mirrors the seal Wplace draws, hides its copy, and forgets it with the layer', async () => {
    const map = fakeMap()
    syncOfficialOverlays(map)
    // Wplace adds the layer first and hands over the art once its image has loaded.
    map.addLayer(LAYER)
    expect(mirrors()).toEqual([])
    map.layer(LAYER)?.setData({ pixels: sealArt(), coordinates: [corner(1_466_000, 920_000)] })

    await vi.waitFor(() => expect(mirrors()).toHaveLength(1))
    expect(mirrors()[0]).toMatchObject({
      name: 'Official overlay 2',
      originX: 1_466_000,
      originY: 920_000,
      width: 2,
      height: 2,
      opaque: 4,
    })
    expect([...(mirrors()[0]?.indices ?? [])]).toEqual([1, 2, 3, 4])
    expect(map.visibility.get(LAYER)).toBe('none')
    // Colour navigation and full progress scans walk these tiles.
    expect([...templateTileKeys(mirrors()[0] as PlacedTemplate)]).toEqual(['1466/920'])

    map.removeLayer(LAYER)
    await vi.waitFor(() => expect(mirrors()).toEqual([]))
  })

  it('keeps the mirror when Wplace recreates the layer before queued work drains', async () => {
    const map = fakeMap()
    syncOfficialOverlays(map)
    const art = { pixels: sealArt(), coordinates: [corner(1_466_000, 920_000)] }
    map.addLayer(LAYER)
    map.layer(LAYER)?.setData(art)
    await vi.waitFor(() => expect(mirrors()).toHaveLength(1))

    map.layer(LAYER)?.setData(art)
    map.removeLayer(LAYER)
    map.addLayer(LAYER)
    map.layer(LAYER)?.setData(art)

    await vi.waitFor(() => expect(map.visibility.get(LAYER)).toBe('none'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mirrors()).toHaveLength(1)
  })
})
