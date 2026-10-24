import { encodeIndexedPng } from '@caelestis/shared'
import './open-menu.js'
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
import { installWplaceCursors } from '../src/wplace-cursors.js'
import { installWplaceFont } from '../src/wplace-font.js'
import { runPanelSurfaceContracts } from './panel-surfaces.js'
import { runSparseOutlineContracts } from './sparse-outlines.js'

const tile = { x: 3, y: 4 }
const TILE_SIZE = 1_000
const UNPAINTED = 255
const templatePixels = new Uint8Array([5, 6, 7, 8])
/** Stands for the template's pixels, which the worker caches its window of. */
const templateSource = {}

const scan = (server: Uint8Array, templateKey = 'browser-template|0/0|0,0') =>
  scanInWorker(
    {
      // A window key: the template id, then the tile and the template's origin.
      templateKey,
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
    // The window transfers to the worker, so each read hands over a fresh copy.
    () => templatePixels.slice(),
    templateSource,
  )

/** Browser-only contracts: production worker transfer/cache lifecycle and browser canvas readback. */
export const runProductionBrowserBoundaries = async () => {
  const surfaces = await runPanelSurfaceContracts()
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
  // A move to another tile leaves the window cut at the old origin unread forever.
  await scan(new Uint8Array([5, UNPAINTED, 1, 8]), 'browser-template|1/0|2,0')
  if (mismatchWorkerMemoryBytes() !== templatePixels.byteLength)
    throw new Error('the mismatch worker kept a window from before a move')
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
  runSparseOutlineContracts()

  // Font override contract against Wplace's own font rules as shipped (copied verbatim from
  // wplace.live's `0.Brd0iqiK.css`), so the override is tested against the cascade it has to win.
  const GEIST_SANS =
    '"Geist", ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"'
  const SYSTEM_MONO =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
  const PIXEL =
    '"Pixelify Sans", ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"'
  const PIXEL_DISPLAY = '"Pixelify Sans", "Press Start 2P", system-ui, monospace'
  const WPLACE_FONT_RULES =
    `@layer theme{:root,:host{--font-sans:${GEIST_SANS};--font-mono:${SYSTEM_MONO};--font-pixel:${PIXEL};--font-pixel-display:${PIXEL_DISPLAY}}}` +
    ':root[data-standard-ui],.font-readable{--font-pixel:var(--font-sans);--font-pixel-display:var(--font-sans)}' +
    '.font-readable{--font-sans:"Geist", ui-sans-serif, system-ui, sans-serif;--font-mono:"Geist Mono", ui-monospace, monospace;--pixel-font-snap:0;font-family:var(--font-sans);-webkit-font-smoothing:auto}'
  const wplaceStyle = document.createElement('style')
  wplaceStyle.textContent = WPLACE_FONT_RULES
  document.head.append(wplaceStyle)
  const root = document.documentElement
  const readable = document.body.appendChild(document.createElement('p'))
  readable.className = 'font-readable'
  const originalLang = root.getAttribute('lang')
  const fontVar = (element: Element, name: string) =>
    getComputedStyle(element).getPropertyValue(name).trim().replace(/\s+/g, ' ')
  /** All four of Wplace's font properties on `element`: sans, mono, pixel, pixel display. */
  const expectStacks = (
    condition: string,
    [sans, mono, pixel, pixelDisplay]: readonly [string, string, string, string],
    element: Element = root,
  ) => {
    for (const [name, expected] of [
      ['--font-sans', sans],
      ['--font-mono', mono],
      ['--font-pixel', pixel],
      ['--font-pixel-display', pixelDisplay],
    ]) {
      const actual = fontVar(element, name)
      if (actual !== expected)
        throw new Error(`font override ${condition}: ${name} is ${JSON.stringify(actual)}`)
    }
  }
  const falseType = (cjk: string) => {
    const sans = `"FalseType", "Pixelify Sans", "WPlace Pixel Mono", "${cjk}", ui-sans-serif, system-ui, sans-serif`
    const mono = `"FalseType", "WPlace Pixel Mono", "Pixelify Sans", "${cjk}", ui-monospace, monospace`
    return [sans, mono, sans, sans] as const
  }
  const WPLACE = [GEIST_SANS, SYSTEM_MONO, PIXEL, PIXEL_DISPLAY] as const
  const expectSmoothing = (condition: string) => {
    const actual = getComputedStyle(root).webkitFontSmoothing
    if (actual !== 'auto')
      throw new Error(`font override ${condition}: -webkit-font-smoothing is ${actual}`)
  }
  installWplaceFont()
  try {
    expectStacks('on a default root', falseType('Fusion Pixel Chinese'))
    expectStacks('inside .font-readable', falseType('Fusion Pixel Chinese'), readable)
    expectSmoothing('on a default root')
    for (const lang of ['ja', 'jp']) {
      root.setAttribute('lang', lang)
      expectStacks(`with lang=${lang}`, falseType('Fusion Pixel Japanese'))
      expectStacks(
        `inside .font-readable with lang=${lang}`,
        falseType('Fusion Pixel Japanese'),
        readable,
      )
      expectSmoothing(`with lang=${lang}`)
    }
    root.removeAttribute('lang')
    // Legacy UI leaves Wplace's fonts alone: its pixel properties fall back to Geist.
    root.setAttribute('data-standard-ui', '')
    expectStacks('with data-standard-ui', [GEIST_SANS, SYSTEM_MONO, GEIST_SANS, GEIST_SANS])
    root.removeAttribute('data-standard-ui')
    // Our own FalseType switch opts out through an attribute: Wplace's stacks come back.
    root.setAttribute('data-caelestis-falsetype', 'off')
    expectStacks('with data-caelestis-falsetype=off', WPLACE)
    root.removeAttribute('data-caelestis-falsetype')
    expectStacks('after restoring the root', falseType('Fusion Pixel Chinese'))
    expectSmoothing('after restoring the root')
    const faces = await document.fonts.load('12px "FalseType"')
    if (faces.length !== 1) throw new Error('the bundled FalseType face did not load')
  } finally {
    wplaceStyle.remove()
    readable.remove()
    root.removeAttribute('data-standard-ui')
    root.removeAttribute('data-caelestis-falsetype')
    if (originalLang === null) root.removeAttribute('lang')
    else root.setAttribute('lang', originalLang)
  }

  // Cursor contract against Wplace's cursor rules as shipped: pixel art on :root and redefined
  // under :root[data-theme=dark], plain keywords under :root[data-standard-ui] or
  // :root[data-native-cursor]. Ours must beat the dark-theme rule and step aside for the rest.
  const cursorStyle = document.createElement('style')
  cursorStyle.textContent =
    ':root{--cursor-pointer:url("data:image/svg+xml,x") 12 7, pointer}' +
    ':root[data-theme=dark]{--cursor-pointer:url("data:image/svg+xml,y") 12 7, pointer}' +
    ':root[data-standard-ui],:root[data-native-cursor]{--cursor-pointer:pointer}'
  document.head.append(cursorStyle)
  installWplaceCursors()
  try {
    root.setAttribute('data-theme', 'dark')
    const cursor = () => getComputedStyle(root).getPropertyValue('--cursor-pointer').trim()
    const expectCursor = (condition: string, expected: string) => {
      const actual = cursor()
      if (actual !== expected)
        throw new Error(`cursor override ${condition}: is ${JSON.stringify(actual)}`)
    }
    if (!cursor().startsWith('image-set('))
      throw new Error(`cursor override by default: is ${JSON.stringify(cursor())}`)
    root.setAttribute('data-caelestis-cursors', 'off')
    expectCursor('with data-caelestis-cursors=off', 'url("data:image/svg+xml,y") 12 7, pointer')
    root.removeAttribute('data-caelestis-cursors')
    root.setAttribute('data-native-cursor', '')
    expectCursor('with data-native-cursor', 'pointer')
    root.removeAttribute('data-native-cursor')
    root.setAttribute('data-standard-ui', '')
    expectCursor('with data-standard-ui', 'pointer')
  } finally {
    cursorStyle.remove()
    root.removeAttribute('data-theme')
    root.removeAttribute('data-caelestis-cursors')
    root.removeAttribute('data-native-cursor')
    root.removeAttribute('data-standard-ui')
  }
  return {
    surfaces,
    canvasCaptured: true,
    bitmapRgba: rgba,
    scans: [first.completed, cached.completed, afterForget.completed],
    fontStacks: true,
  }
}

Object.assign(window, { runProductionBrowserBoundaries })
