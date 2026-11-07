// @vitest-environment happy-dom
import { WPLACE_PALETTE } from '@caelestis/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ActiveAllianceSurface } from '../alliance-surface.js'
import { nativePixelAt } from '../native-pixels.js'
import { readArtboardPixels, refreshArtboardPixels, trackArtboardTiles } from './artboard-pixels.js'

// Wplace's HQ as Caelestis meets it: a 128×64 artboard drawn at one CSS pixel per HQ pixel, two
// 64×64 store tiles, a screen-space `.hq-tile-layer`, and 10px crosshair cells marking drafts.
const TILE = 64
const geometry = { originX: 0, originY: 0, width: 128, height: 64 }
const RED = 5
const GREEN = 13

type Paint = (x: number, y: number) => readonly [number, number, number, number]
const painted = new WeakMap<HTMLCanvasElement, Paint>()

const canvasOf = (width: number, height: number, paint: Paint): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  painted.set(canvas, paint)
  return canvas
}

/** A Wplace store tile canvas: transparent except the given palette pixels. */
const tileCanvas = (pixels: Record<string, number>): HTMLCanvasElement =>
  canvasOf(TILE, TILE, (x, y) => {
    const index = pixels[`${x},${y}`]
    if (index === undefined) return [0, 0, 0, 0]
    const [r, g, b] = WPLACE_PALETTE[index]?.rgb ?? [0, 0, 0]
    return [r, g, b, 255]
  })

let allianceId = 0
let active: ActiveAllianceSurface
let layer: HTMLCanvasElement
let snapshots: Uint8Array[]

/** Encode Wplace's HQ snapshot: tile 0/0 with the given palette pixels, at one version. */
const snapshot = (version: number, pixels: Record<string, number>): ArrayBuffer => {
  const bytes = new Uint8Array(19 + 12 + TILE * TILE)
  const view = new DataView(bytes.buffer)
  bytes.set([...'WHQS1'].map((char) => char.charCodeAt(0)))
  view.setUint16(5, TILE, true)
  view.setUint16(15, 1, true)
  view.setBigInt64(19 + 4, BigInt(version), true)
  for (const [key, index] of Object.entries(pixels)) {
    const [x = 0, y = 0] = key.split(',').map(Number)
    bytes[19 + 12 + y * TILE + x] = index + 1
  }
  return bytes.buffer
}

const commit = async (version: number, pixels: Record<string, number>): Promise<void> => {
  snapshots.push(new Uint8Array(snapshot(version, pixels)))
  await refreshArtboardPixels(active, geometry)
}

/** Wplace repaints the layer: clear it, then draw each visible tile canvas at its screen spot. */
const repaint = (visible: Record<number, HTMLCanvasElement>): void => {
  trackArtboardTiles(active, geometry, layer, null)
  for (const [x, source] of Object.entries(visible))
    trackArtboardTiles(active, geometry, layer, {
      source,
      x: Number(x),
      y: 0,
      width: TILE,
      height: TILE,
    })
}

/** Wplace's crosshair tile over HQ tile 0/0, marking the given drafted pixels. */
const mark = (...cells: readonly (readonly [number, number])[]): HTMLElement => {
  const marks = document.createElement('div')
  marks.className = 'paint-crosshair-layer'
  const canvas = canvasOf(TILE * 10, TILE * 10, (x, y) =>
    cells.some(([cellX, cellY]) => x === cellX * 10 && y === cellY * 10)
      ? [0, 0, 0, 255]
      : [0, 0, 0, 0],
  )
  canvas.className = 'paint-crosshair-tile'
  canvas.style.cssText = `left: 0px; top: 0px; width: ${TILE}px; height: ${TILE}px`
  marks.append(canvas)
  active.stage.append(marks)
  return marks
}

const pixelAt = (x: number, y: number) =>
  nativePixelAt(readArtboardPixels(active, geometry), x, y)

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    const paint = painted.get(this)
    return {
      getImageData: (left: number, top: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4)
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++)
            data.set(paint?.(left + x, top + y) ?? [0, 0, 0, 0], (y * width + x) * 4)
        return { width, height, data }
      },
    } as unknown as CanvasRenderingContext2D
  })
  snapshots = []
  vi.spyOn(window, 'fetch').mockImplementation(async () => {
    const body = snapshots.shift() ?? new Uint8Array(snapshot(0, {}))
    return new Response(body, {
      headers: { 'content-type': 'application/x-wplace-alliance-hq-snapshot' },
    })
  })
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  layer = document.createElement('canvas')
  layer.className = 'hq-tile-layer'
  layer.width = geometry.width
  layer.height = geometry.height
  frame.append(layer)
  stage.append(frame)
  document.body.append(stage)
  const rect = () => new DOMRect(0, 0, geometry.width, geometry.height)
  frame.getBoundingClientRect = rect
  layer.getBoundingClientRect = rect
  allianceId++
  active = {
    surface: { kind: 'alliance-headquarters', allianceId },
    stage,
    frame,
    draftId: null,
    bounds: { minX: 0, minY: 0, maxX: geometry.width, maxY: geometry.height },
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

it('reads a drafted HQ pixel from the tile Wplace draws', async () => {
  await commit(1, {})
  repaint({ 0: tileCanvas({ '1,1': RED }) })
  expect(pixelAt(1, 1)).toEqual({ index: RED, source: 'draft' })
})

it('keeps a marked offscreen draft, and drops it when an offscreen undo removes its mark', async () => {
  await commit(1, {})
  const marks = mark([1, 1])
  repaint({ 0: tileCanvas({ '1,1': RED }) })
  repaint({ 64: tileCanvas({}) })
  expect(pixelAt(1, 1)).toEqual({ index: RED, source: 'draft' })
  marks.remove()
  expect(pixelAt(1, 1)?.source).toBe('committed')
})

it('counts only the marked pixels of an offscreen tile after a newer committed snapshot', async () => {
  await commit(1, { '2,2': GREEN })
  mark([1, 1])
  repaint({ 0: tileCanvas({ '1,1': RED, '2,2': GREEN }) })
  repaint({ 64: tileCanvas({}) })
  await commit(2, { '2,2': RED })
  expect(pixelAt(1, 1)).toEqual({ index: RED, source: 'draft' })
  expect(pixelAt(2, 2)).toEqual({ index: RED, source: 'committed' })
})

it('ignores an offscreen tile while Wplace shows no draft marks', async () => {
  await commit(1, {})
  repaint({ 0: tileCanvas({ '1,1': RED }) })
  repaint({ 64: tileCanvas({}) })
  expect(pixelAt(1, 1)?.source).toBe('committed')
})
