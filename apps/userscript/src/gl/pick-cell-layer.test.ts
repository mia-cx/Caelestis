import { canvasPixelToLatLng } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A map turned 45°: lng and lat scaled up, then rotated, so a cell's corners are a diamond. */
const BEARING = Math.PI / 4
const SCALE = 40_000
const map = {
  getCanvas: () => ({ width: 1600, height: 1200, clientWidth: 800 }),
  getCenter: () => ({ lng: 0 }),
  project: ([lng, lat]: [number, number]) => ({
    x: 400 + SCALE * (lng * Math.cos(BEARING) - lat * Math.sin(BEARING)),
    y: 300 - SCALE * (lng * Math.sin(BEARING) + lat * Math.cos(BEARING)),
  }),
  triggerRepaint: () => {},
}
vi.mock('../map-handle.js', () => ({ getMap: () => map }))

const { pickCellLayer, showPickCell } = await import('./pick-cell-layer.js')

/** The rectangles the layer cleared on one frame. */
const render = (): (readonly number[])[] => {
  const cleared: (readonly number[])[] = []
  let scissor: readonly number[] = []
  pickCellLayer.render({
    SCISSOR_TEST: 0,
    COLOR_BUFFER_BIT: 0,
    enable: () => {},
    disable: () => {},
    clearColor: () => {},
    scissor: (...rect: number[]) => {
      scissor = rect
    },
    clear: () => cleared.push(scissor),
  } as unknown as WebGL2RenderingContext)
  return cleared
}

const release = (): void => {
  window.dispatchEvent(new Event('pointerup'))
}

describe('pick cell layer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    release()
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('clears every corner of the picked cell on a rotated map', () => {
    const cell = { x: 1_024_000, y: 1_024_000 }
    showPickCell(cell.x, cell.y, 1)
    const [rect] = render()
    if (rect === undefined) throw new Error('nothing cleared')
    const [left = 0, bottomUp = 0, width = 0, height = 0] = rect
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const { lat, lng } = canvasPixelToLatLng({ x: cell.x + dx, y: cell.y + dy })
      const { x, y } = map.project([lng, lat])
      // Framebuffer pixels are twice CSS pixels here, counted up from the bottom.
      expect(x * 2).toBeGreaterThanOrEqual(left)
      expect(x * 2).toBeLessThanOrEqual(left + width)
      expect(1200 - y * 2).toBeGreaterThanOrEqual(bottomUp)
      expect(1200 - y * 2).toBeLessThanOrEqual(bottomUp + height)
    }
  })

  it('holds the cell through a long press and hides it shortly after release', () => {
    showPickCell(1_024_000, 1_024_000, 1)
    vi.advanceTimersByTime(5000)
    expect(render()).toHaveLength(1)

    release()
    vi.advanceTimersByTime(400)
    expect(render()).toHaveLength(1)
    vi.advanceTimersByTime(200)
    expect(render()).toHaveLength(0)
  })
})
