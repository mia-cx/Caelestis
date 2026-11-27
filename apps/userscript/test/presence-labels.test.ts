import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { TILE_SIZE } from '@caelestis/shared'
import { expect, it, vi } from 'vitest'
import type { ScreenProjection, TileFrame } from '../src/coordinates.js'
import type { SceneItem } from '../src/presence-scene.js'

const scenes = vi.hoisted(() => ({ current: [] as readonly SceneItem[] }))

vi.mock('../src/presence-scene.js', () => ({
  presenceScene: () => scenes.current,
  displayedRect: (item: SceneItem) => item.rect,
  setHoveredSceneItems: () => {},
}))
vi.mock('../src/tile-frame.js', () => ({ isDrawingTiles: () => true }))

setFlagsFromString('--expose-gc')
const collect: () => void = runInNewContext('gc')

/** One peer browsing over the canvas's top-left corner. */
const peerScene = (): readonly SceneItem[] => {
  const painter = { wplaceUserId: 7, displayName: 'Other painter' }
  const peer = { sessionId: 'peer', painter, viewport: { x: 10, y: 10, w: 50, h: 50 }, draft: null }
  return [
    {
      id: 'peer:peer:viewport',
      kind: 'viewport',
      rect: peer.viewport,
      painter,
      mask: null,
      mine: false,
      aside: 'peer:peer:viewport',
      follows: false,
      source: { kind: 'peer', peer },
    },
  ]
}

it('lets a superseded scene go once the pointer leaves the map', async () => {
  const { renderPresenceLabels } = await import('../src/presence-labels.js')
  const canvas = document.createElement('canvas')
  canvas.className = 'maplibregl-canvas'
  canvas.width = TILE_SIZE
  canvas.height = TILE_SIZE
  document.body.appendChild(canvas)
  // One tile fills the canvas, one device pixel to a canvas pixel.
  const frame: TileFrame = {
    canvas,
    quads: [{ tile: { x: 0, y: 0 }, x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE }],
  }
  const projection: ScreenProjection = {
    canvasBox: { left: 0, top: 0, width: TILE_SIZE, height: TILE_SIZE },
    pointFor: (x, y) => ({ x, y }),
    pixelsPerCanvasPixel: { x: 1, y: 1 },
  }
  const pointAt = (target: Element, x: number) =>
    target.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: 20 }),
    )
  // Built inside a function so the test itself never holds the first scene.
  const hover = (): WeakRef<readonly SceneItem[]> => {
    scenes.current = peerScene()
    renderPresenceLabels(frame, projection)
    pointAt(canvas, 20)
    renderPresenceLabels(frame, projection)
    expect(document.getElementById('caelestis-presence-labels')?.textContent).toBe('Other painter')
    return new WeakRef(scenes.current)
  }
  const first = hover()
  // A newer scene arrives while the pointer is off the map, so no frame looks at it.
  scenes.current = peerScene()
  pointAt(document.body, 20)
  renderPresenceLabels(frame, projection)
  // A new WeakRef holds its target until the current job ends, so collect after yielding.
  await new Promise((done) => setTimeout(done, 0))
  collect()
  expect(first.deref()).toBeUndefined()
})
