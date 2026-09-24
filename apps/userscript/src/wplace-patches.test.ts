import { afterEach, describe, expect, it } from 'vitest'
import {
  applyWplacePatches,
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

/** MapLibre's `moveLayer` contract: reorder `style._order`, ignoring unknown ids. */
const orderedMap = (order: string[]) => ({
  style: { _order: order },
  moves: 0,
  moveLayer(id: string, before?: string) {
    if (!this.style._order.includes(id)) return this
    const next = this.style._order.filter((layer) => layer !== id)
    next.splice(before === undefined ? next.length : next.indexOf(before), 0, id)
    if (next.join() !== this.style._order.join()) this.moves++
    this.style._order = next
    return this
  },
})

/** Wplace's `styledata` listener, as shipped: fill below the art, the rest moved to the top. */
const wplaceListener = (map: PatchableMap): void => {
  map.moveLayer?.(FILL, 'pixel-art-layer')
  map.moveLayer?.(WHITE)
  map.moveLayer?.(COLOUR)
  map.moveLayer?.(IMAGE)
}

/** A loaded MapLibre canvas source: `play`/`pause` decide whether it forces every frame. */
const canvasSource = () => {
  let playing = true
  return {
    getCanvas: () => ({}),
    play: () => {
      playing = true
    },
    pause: () => {
      playing = false
    },
    hasTransition: () => playing,
  }
}

afterEach(() => {
  resetWplacePatches()
})

describe('highlight-order patch', () => {
  it('reaches the listener order once, then stops moving layers on every style update', () => {
    const map = orderedMap(['water', 'pixel-art-layer', 'pixel-hover', FILL, WHITE, COLOUR, IMAGE])
    applyWplacePatches(map)
    wplaceListener(map)
    expect(map.style._order).toEqual([
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
  })

  it('lets every move through when switched off', () => {
    const map = orderedMap(['water', FILL, 'pixel-art-layer', WHITE, COLOUR])
    setWplacePatchEnabled('highlight-order', false)
    applyWplacePatches(map)
    wplaceListener(map)
    const moves = map.moves
    wplaceListener(map)
    expect(map.moves).toBeGreaterThan(moves)
  })

  it('never blocks moves of other layers, including Caelestis layers', () => {
    const map = orderedMap(['a', 'b', 'caelestis-markers'])
    applyWplacePatches(map)
    map.moveLayer('caelestis-markers', 'a')
    expect(map.style._order).toEqual(['caelestis-markers', 'a', 'b'])
  })
})

describe('hover-canvas patch', () => {
  it('stops only the pixel-hover source from forcing frames, leaving draft sources playing', () => {
    const hover = canvasSource()
    const draft = canvasSource()
    const sources: Record<string, unknown> = {
      'pixel-hover': hover,
      'paint-preview-0.1-1,2': draft,
    }
    applyWplacePatches({ getSource: (id) => sources[id] })
    expect(hover.hasTransition()).toBe(false)
    expect(draft.hasTransition()).toBe(true)
  })

  it('pauses a hover source Wplace re-creates after a style reload as soon as it loads', () => {
    let listener: ((event: { sourceId?: string }) => void) | undefined
    let hover: ReturnType<typeof canvasSource> | undefined
    applyWplacePatches({
      getSource: () => hover,
      on: (_type, fn) => {
        listener = fn
      },
    })
    hover = canvasSource()
    listener?.({ sourceId: 'pixel-hover' })
    expect(hover.hasTransition()).toBe(false)
  })

  it('restores the source it paused when switched off', () => {
    const hover = canvasSource()
    const map = { getSource: () => hover }
    applyWplacePatches(map)
    setWplacePatchEnabled('hover-canvas', false)
    applyWplacePatches(map)
    expect(hover.hasTransition()).toBe(true)
  })
})

describe('marker-animations patch', () => {
  it('pauses animations only on hidden markers, and stops when switched off', () => {
    document.body.innerHTML = `
      <div class="maplibregl-marker" id="hidden" style="transform: none; opacity: 0;">
        <div class="wplace-marker-root"><div class="wplace-marker-ping"></div></div>
      </div>
      <div class="maplibregl-marker" id="shown" style="transform: none; opacity: 0.5;">
        <div class="wplace-marker-root"></div>
      </div>`
    const state = (selector: string) =>
      getComputedStyle(document.querySelector(selector) as Element).animationPlayState
    applyWplacePatches(null)
    expect(state('#hidden .wplace-marker-root')).toBe('paused')
    expect(state('#hidden .wplace-marker-ping')).toBe('paused')
    expect(state('#shown .wplace-marker-root')).not.toBe('paused')
    setWplacePatchEnabled('marker-animations', false)
    applyWplacePatches(null)
    expect(state('#hidden .wplace-marker-root')).not.toBe('paused')
  })
})

describe('switches', () => {
  it('persist a switched-off patch across reloads and announce the change', () => {
    const seen: string[] = []
    onWplacePatchChange((patch, enabled) => seen.push(`${patch}:${enabled}`))
    setWplacePatchEnabled('tile-refresh', false)
    resetWplacePatches()
    expect(isWplacePatchEnabled('tile-refresh')).toBe(false)
    expect(isWplacePatchEnabled('hover-canvas')).toBe(true)
    expect(seen).toEqual(['tile-refresh:false'])
  })

  it('ignores malformed and unknown stored switches', () => {
    localStorage.setItem('caelestis.wplace-patches.v1', JSON.stringify(['nope', 'hover-canvas']))
    expect(isWplacePatchEnabled('hover-canvas')).toBe(false)
    expect(isWplacePatchEnabled('nope' as never)).toBe(true)
    resetWplacePatches()
    localStorage.setItem('caelestis.wplace-patches.v1', '{not json')
    expect(isWplacePatchEnabled('hover-canvas')).toBe(true)
  })
})
