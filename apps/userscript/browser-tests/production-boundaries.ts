import { encodeIndexedPng } from '@caelestis/shared'
import {
  forgetInWorker,
  mismatchWorkerMemoryBytes,
  scanInWorker,
} from '../src/templates/mismatch-worker.js'
import {
  captureTilePixels,
  clearDraftPixels,
  draftPixels,
  install,
  loadTilePixels,
  registerDraftCanvas,
} from '../src/tile-transform.js'

const tile = { x: 3, y: 4 }
const TILE_SIZE = 1_000
const UNPAINTED = 255
const templatePixels = new Uint8Array([5, 6, 7, 8])

const scan = (server: Uint8Array) =>
  scanInWorker(
    {
      templateKey: 'browser-template',
      kind: 'pixels',
      width: 2,
      height: 2,
      originX: 0,
      originY: 0,
      tileX: 0,
      tileY: 0,
      tileSize: 2,
      bandTop: 0,
      draft: null,
      server,
      ignored: [0, UNPAINTED],
      transparent: 0,
      unpainted: UNPAINTED,
    },
    templatePixels,
  )

/** Browser-only contracts: production worker transfer/cache lifecycle and browser canvas readback. */
export const runProductionBrowserBoundaries = async () => {
  // Simulate Wplace loading its map before the userscript installs its capture hooks.
  const tileUrl = 'https://backend.wplace.live/files/s3/tiles/3/4.png'
  const encoded = await encodeIndexedPng(
    TILE_SIZE,
    TILE_SIZE,
    new Uint8Array(TILE_SIZE * TILE_SIZE).fill(5),
  )
  const originalEntries = performance.getEntriesByType.bind(performance)
  Object.defineProperty(performance, 'getEntriesByType', {
    configurable: true,
    value: (type: string) => (type === 'resource' ? [{ name: tileUrl }] : originalEntries(type)),
  })
  const requests: string[] = []
  window.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url !== tileUrl) throw new Error(`Unexpected browser contract request: ${url}`)
    return new Response(Uint8Array.from(encoded), { headers: { 'content-type': 'image/png' } })
  }
  install(window)
  captureTilePixels(true)
  const recovered = await loadTilePixels(tile)
  if (recovered?.length !== TILE_SIZE * TILE_SIZE || recovered.some((pixel) => pixel !== 5))
    throw new Error('Refresh recovery did not decode the tile loaded before capture installed')
  if (requests.length !== 1 || requests[0] !== tileUrl)
    throw new Error('Refresh recovery fetched unexpected tiles')
  Object.defineProperty(performance, 'getEntriesByType', {
    configurable: true,
    value: originalEntries,
  })
  const canvas = document.createElement('canvas')
  canvas.width = TILE_SIZE
  canvas.height = TILE_SIZE
  registerDraftCanvas(canvas, tile)
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Chromium did not provide a 2D canvas context')
  // Black is palette index zero, so production RGB indexing must retain this canvas write.
  const painted = new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1)
  context.putImageData(painted, 2, 3)
  const draft = draftPixels(tile)
  if (draft === null || !draft.some((index) => index !== UNPAINTED))
    throw new Error('tile-transform did not retain a real canvas write')

  const bitmapSource = new OffscreenCanvas(1, 1)
  const bitmapContext = bitmapSource.getContext('2d')
  if (bitmapContext === null) throw new Error('Chromium did not provide an OffscreenCanvas context')
  bitmapContext.fillStyle = '#1a2b3c'
  bitmapContext.fillRect(0, 0, 1, 1)
  const bitmap = bitmapSource.transferToImageBitmap()
  const target = new OffscreenCanvas(1, 1)
  const targetContext = target.getContext('2d')
  if (targetContext === null) throw new Error('Chromium did not provide a bitmap target context')
  targetContext.drawImage(bitmap, 0, 0)
  const rgba = [...targetContext.getImageData(0, 0, 1, 1).data]
  bitmap.close()
  if (rgba.join(',') !== '26,43,60,255') throw new Error(`ImageBitmap draw changed pixels: ${rgba}`)

  const first = await scan(new Uint8Array([5, UNPAINTED, 1, 8]))
  const cached = await scan(new Uint8Array([5, UNPAINTED, 1, 8]))
  forgetInWorker('browser-template')
  const afterForget = await scan(new Uint8Array([5, UNPAINTED, 1, 8]))
  forgetInWorker('browser-template')
  clearDraftPixels(tile)
  if (first === null || cached === null || afterForget === null)
    throw new Error('production mismatch worker did not answer a scan')
  if (
    [first, cached, afterForget].some(
      (outcome) =>
        outcome.completed !== 2 || outcome.mismatched !== 1 || outcome.progressUnpainted !== 1,
    )
  )
    throw new Error('production mismatch worker changed the scan result across cache lifecycle')
  if (mismatchWorkerMemoryBytes() !== 0)
    throw new Error('forgetInWorker retained browser test pixels')
  return {
    canvasCaptured: true,
    bitmapRgba: rgba,
    scans: [first.completed, cached.completed, afterForget.completed],
  }
}

Object.assign(window, { runProductionBrowserBoundaries })
