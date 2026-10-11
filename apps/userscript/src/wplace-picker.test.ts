import { WORLD_TEMPLATE_SURFACE, WPLACE_PALETTE } from '@caelestis/shared'
import { expect, it, vi } from 'vitest'
import { addLocalTemplate, removeLocalTemplate } from './templates/local-store.js'
import { isPaintOpen, watchPaintSelection } from './wplace-paint.js'
import { installColourPicker, overlayIndexAt } from './wplace-picker.js'

// Wplace owns projection and native tile reads. Keep our template lookup and swatch selection real.
vi.mock('./main.js', () => ({ canvasPixelAt: () => ({ x: 100, y: 200 }) }))
vi.mock('./map-handle.js', () => ({ getMap: () => null }))
vi.mock('./alliance-surface.js', () => ({
  activeAllianceSurface: () => null,
  activeAllianceEditorStage: () => null,
}))
vi.mock('./gl/artboard-pixels.js', () => ({
  readArtboardPixels: () => ({ committed: [], draft: [] }),
}))
vi.mock('./tile-transform.js', () => ({ ensureTilePixels: () => false }))
vi.mock('./world-native-pixels.js', () => ({
  worldNativePixels: () => ({ committed: [], draft: [] }),
}))
vi.mock('./templates/move.js', () => ({ isMoving: () => false }))

it('picks the local source colour with translated controls in both Wplace icon themes', async () => {
  const colour = WPLACE_PALETTE.find((entry) => entry.name === 'White')
  if (colour === undefined) throw new Error('Missing White palette entry')
  const template = await addLocalTemplate(
    {
      id: 'picker-local',
      name: 'Local template',
      source: 'wplace',
      originX: 100,
      originY: 200,
      width: 1,
      height: 1,
      indices: new Uint8Array([colour.index]),
      moved: 0,
      opaque: 1,
    },
    undefined,
    true,
  )
  document.body.innerHTML = `
    <div class="maplibregl-canvas-container"><canvas></canvas></div>
    <button class="btn-primary" aria-pressed="true"><svg><path></path></svg></button>
    <button id="color-${colour.index + 1}" aria-label="Белый"></button>
  `
  const canvas = document.querySelector('canvas')
  const picker = document.querySelector('button')
  const path = picker?.querySelector('path')
  const swatch = document.getElementById(`color-${colour.index + 1}`)
  if (canvas === null || picker === null || path == null || swatch === null)
    throw new Error('Missing picker fixture controls')

  let picked: number | null = null
  swatch.addEventListener('click', () => {
    picked = colour.index
    picker.classList.remove('btn-primary')
    picker.setAttribute('aria-pressed', 'false')
  })
  // If our interception misses, Wplace quantises the composite (including mismatch markers).
  for (const type of ['pointerdown', 'click'])
    canvas.addEventListener(type, () => {
      if (!picker.classList.contains('btn-primary')) return
      picked = 0
      picker.classList.remove('btn-primary')
    })
  const removeListeners: (() => void)[] = []
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    add(type, listener, options)
    removeListeners.push(() => window.removeEventListener(type, listener, options))
  })
  const observers: MutationObserver[] = []
  const NativeObserver = MutationObserver
  vi.stubGlobal(
    'MutationObserver',
    class extends NativeObserver {
      constructor(callback: MutationCallback) {
        super(callback)
        observers.push(this)
      }
    },
  )
  try {
    watchPaintSelection()
    expect(isPaintOpen()).toBe(true)
    expect(overlayIndexAt(WORLD_TEMPLATE_SURFACE, 100, 200)).toBe(colour.index)
    installColourPicker()
    for (const label of ['Color Picker', 'Пипетка']) {
      picker.setAttribute('aria-label', label)
      for (const icon of ['M120-120v-190l358-358', 'M3 21h2v2H1v-4h2v2Z']) {
        path.setAttribute('d', icon)
        picker.classList.add('btn-primary')
        picker.setAttribute('aria-pressed', 'true')
        picked = null
        canvas.dispatchEvent(
          new PointerEvent('pointerdown', {
            button: 0,
            pointerId: 1,
            clientX: 10,
            clientY: 10,
            bubbles: true,
            cancelable: true,
          }),
        )
        canvas.dispatchEvent(
          new MouseEvent('click', {
            button: 0,
            clientX: 10,
            clientY: 10,
            bubbles: true,
            cancelable: true,
          }),
        )
        expect(picked, `${label} with ${icon}`).toBe(colour.index)
      }
    }
  } finally {
    for (const remove of removeListeners) remove()
    for (const observer of observers) observer.disconnect()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.replaceChildren()
    await removeLocalTemplate(template.id)
  }
})
