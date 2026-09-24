// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyWplacePatches,
  highlightMoveIsSatisfied,
  isWplacePatchEnabled,
  onWplacePatchChange,
  type PatchableMap,
  resetWplacePatches,
  setWplacePatchEnabled,
} from './wplace-patches.js'

const FILL = 'highlight-area-fill-q86e0q'
const WHITE = 'highlight-area-line-white-q86e0q'
const COLOUR = 'highlight-area-line-color-q86e0q'
const IMAGE = 'highlight-area-image-layer-q86e0q'

/** A map whose `moveLayer` reorders `style._order` the way MapLibre's does, and counts real moves. */
const orderedMap = (order: string[]) => {
  const map = {
    style: { _order: order },
    moves: 0,
    moveLayer(id: string, before?: string) {
      const at = this.style._order.indexOf(id)
      if (at < 0) return at
      const next = this.style._order.filter((layer) => layer !== id)
      const target = before === undefined ? next.length : next.indexOf(before)
      next.splice(target, 0, id)
      if (next.join() !== this.style._order.join()) this.moves++
      this.style._order = next
      return at
    },
  }
  return map
}

/** Wplace's `styledata` listener, as shipped: fill below the art, the rest moved to the top. */
const wplaceListener = (map: PatchableMap): void => {
  map.moveLayer?.(FILL, 'pixel-art-layer')
  map.moveLayer?.(WHITE)
  map.moveLayer?.(COLOUR)
  map.moveLayer?.(IMAGE)
}

let storage: Map<string, string>

beforeEach(() => {
  storage = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
  resetWplacePatches()
})

afterEach(() => {
  resetWplacePatches()
  vi.unstubAllGlobals()
})

describe('highlightMoveIsSatisfied', () => {
  it('treats the top highlight layers in listener order as settled', () => {
    const order = ['water', FILL, 'pixel-art-layer', 'pixel-hover', WHITE, COLOUR, IMAGE]
    expect(highlightMoveIsSatisfied(order, WHITE)).toBe(true)
    expect(highlightMoveIsSatisfied(order, COLOUR)).toBe(true)
    expect(highlightMoveIsSatisfied(order, IMAGE)).toBe(true)
    expect(highlightMoveIsSatisfied(order, FILL, 'pixel-art-layer')).toBe(true)
  })

  it('still moves a layer that is below something it should be above', () => {
    expect(highlightMoveIsSatisfied(['a', COLOUR, WHITE], COLOUR)).toBe(false)
    expect(highlightMoveIsSatisfied(['a', WHITE, 'caelestis-markers'], WHITE)).toBe(false)
    expect(highlightMoveIsSatisfied([FILL, 'x', 'pixel-art-layer'], FILL, 'pixel-art-layer')).toBe(
      false,
    )
  })

  it('does not treat another highlight as a sibling', () => {
    expect(highlightMoveIsSatisfied(['a', WHITE, 'highlight-area-line-color-other'], WHITE)).toBe(
      false,
    )
  })

  it('never claims a layer that is not a highlight layer', () => {
    expect(highlightMoveIsSatisfied(['a', 'b'], 'a', 'b')).toBe(false)
    expect(highlightMoveIsSatisfied(['a', 'b'], 'b')).toBe(false)
  })
})

describe('highlight-order patch', () => {
  it('settles the listener after one pass instead of moving layers on every style update', () => {
    const map = orderedMap(['water', 'pixel-art-layer', 'pixel-hover', FILL, WHITE, COLOUR, IMAGE])
    applyWplacePatches(map)
    wplaceListener(map)
    const afterFirstPass = [...map.style._order]
    expect(afterFirstPass).toEqual([
      'water',
      FILL,
      'pixel-art-layer',
      'pixel-hover',
      WHITE,
      COLOUR,
      IMAGE,
    ])
    const moves = map.moves
    for (let i = 0; i < 10; i++) wplaceListener(map)
    expect(map.moves).toBe(moves)
    expect(map.style._order).toEqual(afterFirstPass)
  })

  it('leapfrogs forever without the patch, which is the loop it removes', () => {
    const map = orderedMap(['water', FILL, 'pixel-art-layer', WHITE, COLOUR])
    setWplacePatchEnabled('highlight-order', false)
    applyWplacePatches(map)
    wplaceListener(map)
    const moves = map.moves
    wplaceListener(map)
    expect(map.moves).toBeGreaterThan(moves)
  })

  it('passes every other layer through, including ours', () => {
    const map = orderedMap(['a', 'b', 'caelestis-markers'])
    applyWplacePatches(map)
    map.moveLayer('caelestis-markers', 'a')
    expect(map.style._order).toEqual(['caelestis-markers', 'a', 'b'])
  })
})

/** A MapLibre canvas source after `load()`: `play` and `pause` exist and toggle `_playing`. */
const canvasSource = (playing: boolean) => ({
  _playing: playing,
  getCanvas: () => ({}),
  play() {
    this._playing = true
  },
  pause() {
    this._playing = false
  },
})

describe('hover-canvas patch', () => {
  it('pauses only the pixel-hover canvas source', () => {
    const hover = canvasSource(true)
    const draft = canvasSource(true)
    const sources: Record<string, unknown> = {
      'pixel-hover': hover,
      'paint-preview-0.1-1,2': draft,
    }
    applyWplacePatches({ getSource: (id) => sources[id] })
    expect(hover._playing).toBe(false)
    expect(draft._playing).toBe(true)
  })

  it('pauses a re-created hover source as soon as it loads', () => {
    let listener: ((event: { sourceId?: string }) => void) | undefined
    let hover: ReturnType<typeof canvasSource> | undefined
    applyWplacePatches({
      getSource: () => hover,
      on: (_type, fn) => {
        listener = fn
      },
    })
    hover = canvasSource(true)
    listener?.({ sourceId: 'pixel-hover' })
    expect(hover._playing).toBe(false)
  })

  it('resumes the source it paused when switched off', () => {
    const hover = canvasSource(true)
    const map = { getSource: () => hover }
    applyWplacePatches(map)
    setWplacePatchEnabled('hover-canvas', false)
    applyWplacePatches(map)
    expect(hover._playing).toBe(true)
  })

  it('leaves a source it did not pause alone when switched off', () => {
    const hover = canvasSource(false)
    setWplacePatchEnabled('hover-canvas', false)
    applyWplacePatches({ getSource: () => hover })
    expect(hover._playing).toBe(false)
  })
})

describe('marker-animations patch', () => {
  it('pauses the float and ping animations only on hidden markers', () => {
    applyWplacePatches(null)
    const style = document.head.querySelector<HTMLStyleElement>(
      'style[data-caelestis="wplace-marker-animations"]',
    )
    expect(style?.textContent).toContain('[style*="opacity: 0;"] .wplace-marker-ping')
    expect(style?.disabled).toBe(false)
    setWplacePatchEnabled('marker-animations', false)
    applyWplacePatches(null)
    expect(style?.disabled).toBe(true)
  })
})

describe('switches', () => {
  it('persist the patches switched off and announce changes', () => {
    const seen: string[] = []
    onWplacePatchChange((patch, enabled) => seen.push(`${patch}:${enabled}`))
    setWplacePatchEnabled('tile-refresh', false)
    expect(JSON.parse(storage.get('caelestis.wplace-patches.v1') ?? '[]')).toEqual(['tile-refresh'])
    resetWplacePatches()
    expect(isWplacePatchEnabled('tile-refresh')).toBe(false)
    expect(isWplacePatchEnabled('hover-canvas')).toBe(true)
    expect(seen).toEqual(['tile-refresh:false'])
  })

  it('ignores unknown names in storage', () => {
    storage.set('caelestis.wplace-patches.v1', JSON.stringify(['nope', 'hover-canvas']))
    expect(isWplacePatchEnabled('hover-canvas')).toBe(false)
  })
})
