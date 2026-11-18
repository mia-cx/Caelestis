import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A map zoomed in on the world's centre, where a cell is a few screen pixels wide. */
const SCALE = 40_000
const map = {
  getCanvas: () => ({ width: 1600, height: 1200, clientWidth: 800 }),
  getCenter: () => ({ lng: 0 }),
  project: ([lng, lat]: [number, number]) => ({ x: 400 + SCALE * lng, y: 300 - SCALE * lat }),
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
