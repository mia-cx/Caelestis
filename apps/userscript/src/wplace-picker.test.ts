import {
  type SimulatedInputSwitches,
  TRANSPARENT_INDEX,
  WORLD_TEMPLATE_SURFACE,
  WPLACE_PALETTE,
} from '@caelestis/shared'
import { expect, it, vi } from 'vitest'
import type { ActiveAllianceSurface } from './alliance-surface.js'
import type { NativePixelSnapshot } from './native-pixels.js'
import { isForwardedPaintMove } from './paint-cursor.js'
import { setState } from './state.js'
import { addLocalTemplate, removeLocalTemplate } from './templates/local-store.js'
import { isPaintOpen, watchPaintSelection } from './wplace-paint.js'
import { installColourPicker, overlayIndexAt } from './wplace-picker.js'

// Each test sets the alliance editor it shows and the native art Wplace has drawn in it.
const page = vi.hoisted(() => ({
  alliance: null as ActiveAllianceSurface | null,
  artboard: { committed: [], draft: [] } as NativePixelSnapshot,
}))

// Wplace owns projection and native tile reads. Keep our template lookup and swatch selection real.
// Each 20 screen pixels to the right is the next canvas column.
vi.mock('./main.js', () => ({
  canvasPixelAt: (clientX: number) => ({ x: 100 + Math.floor(clientX / 20), y: 200 }),
}))
vi.mock('./map-handle.js', () => ({ getMap: () => null }))
vi.mock('./alliance-surface.js', () => ({
  activeAllianceSurface: () => page.alliance,
  activeAllianceEditorStage: () => page.alliance?.stage ?? null,
}))
vi.mock('./gl/artboard-pixels.js', () => ({ readArtboardPixels: () => page.artboard }))
vi.mock('./tile-transform.js', () => ({ ensureTilePixels: () => false }))
vi.mock('./world-native-pixels.js', () => ({
  worldNativePixels: () => ({ committed: [], draft: [] }),
}))
vi.mock('./templates/move.js', () => ({ isMoving: () => false }))

const colour = (name: string) => {
  const entry = WPLACE_PALETTE.find((candidate) => candidate.name === name)
  if (entry === undefined) throw new Error(`Missing ${name} palette entry`)
  return entry
}

const EVERY_PICK: SimulatedInputSwitches = {
  'picker-reads-templates': true,
  'middle-click-pick': true,
  'drag-pick': true,
}

/**
 * Install the paint watcher and picker with the given simulated-input switches; the returned
 * teardown removes every listener they add.
 */
const installPicker = (simulatedInput: SimulatedInputSwitches = EVERY_PICK): (() => void) => {
  setState({ simulatedInput })
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
  watchPaintSelection()
  installColourPicker()
  return () => {
    for (const remove of removeListeners) remove()
    for (const observer of observers) observer.disconnect()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    setState({ simulatedInput: {} })
    document.body.replaceChildren()
    page.alliance = null
    page.artboard = { committed: [], draft: [] }
  }
}

it('picks the local source colour with translated controls in both Wplace icon themes', async () => {
  const white = colour('White')
  const template = await addLocalTemplate(
    {
      id: 'picker-local',
      name: 'Local template',
      source: 'wplace',
      originX: 100,
      originY: 200,
      width: 1,
      height: 1,
      indices: new Uint8Array([white.index]),
      moved: 0,
      opaque: 1,
    },
    undefined,
    true,
  )
  document.body.innerHTML = `
    <div class="maplibregl-canvas-container"><canvas></canvas></div>
    <button class="btn-primary" aria-pressed="true"><svg><path></path></svg></button>
    <button id="color-${white.index + 1}" aria-label="Белый"></button>
  `
  const canvas = document.querySelector('canvas')
  const picker = document.querySelector('button')
  const path = picker?.querySelector('path')
  const swatch = document.getElementById(`color-${white.index + 1}`)
  if (canvas === null || picker === null || path == null || swatch === null)
    throw new Error('Missing picker fixture controls')

  let picked: number | null = null
  swatch.addEventListener('click', () => {
    picked = white.index
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
  const teardown = installPicker()
  try {
    expect(isPaintOpen()).toBe(true)
    expect(overlayIndexAt(WORLD_TEMPLATE_SURFACE, 100, 200)).toBe(white.index)
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
        expect(picked, `${label} with ${icon}`).toBe(white.index)
      }
    }
  } finally {
    teardown()
    await removeLocalTemplate(template.id)
  }
})

it('leaves the armed HQ picker working for swatches, empty pixels and painted pixels', async () => {
  const black = colour('Black')
  const red = colour('Red')
  const swatch = (name: string, rgb?: readonly number[]) =>
    `<button class="game-color-swatch" aria-pressed="false" aria-label="${name}"${
      rgb === undefined ? '' : ` style="background: rgb(${rgb.join(' ')})"`
    }></button>`
  document.body.innerHTML = `
    <dialog open>
      <div role="application"><div class="artboard-frame"><canvas></canvas></div></div>
      <button aria-label="Color Picker" aria-pressed="false"></button>
      <button aria-label="Eraser" aria-pressed="false"></button>
      ${swatch('Black', black.rgb)}${swatch('Red', red.rgb)}${swatch('Transparent')}
    </dialog>
  `
  const stage = document.querySelector<HTMLElement>('[role="application"]')
  const frame = document.querySelector<HTMLElement>('.artboard-frame')
  const canvas = document.querySelector('canvas')
  const picker = document.querySelector<HTMLButtonElement>('[aria-label="Color Picker"]')
  const eraser = document.querySelector<HTMLButtonElement>('[aria-label="Eraser"]')
  const swatches = [...document.querySelectorAll<HTMLButtonElement>('.game-color-swatch')]
  const redSwatch = swatches.find((each) => each.getAttribute('aria-label') === 'Red')
  if (
    stage === null ||
    frame === null ||
    canvas === null ||
    picker === null ||
    eraser === null ||
    redSwatch === undefined
  )
    throw new Error('Missing HQ fixture controls')
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 10, 10))
  page.alliance = {
    surface: { kind: 'alliance-headquarters', allianceId: 1 },
    stage,
    frame,
    draftId: null,
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  }
  // A 10x10 HQ with one Black pixel at (1, 1); everything else is unpainted.
  const art = new Uint8Array(100).fill(TRANSPARENT_INDEX)
  art[11] = black.index
  page.artboard = {
    committed: [{ x: 0, y: 0, width: 10, height: 10, pixels: art, emptyIndex: TRANSPARENT_INDEX }],
    draft: [],
  }

  // Wplace's HQ drawer: a swatch leaves the picker armed, the eraser disarms it, and an armed
  // picker answers a pointer on the art itself instead of painting.
  const wplace: string[] = []
  const armed = () => picker.getAttribute('aria-pressed') === 'true'
  const arm = (on: boolean) => {
    picker.setAttribute('aria-pressed', String(on))
    picker.classList.toggle('btn-primary', on)
  }
  const select = (name: string) => {
    for (const each of swatches)
      each.setAttribute('aria-pressed', String(each.getAttribute('aria-label') === name))
  }
  const selected = () =>
    swatches
      .find((each) => each.getAttribute('aria-pressed') === 'true')
      ?.getAttribute('aria-label')
  picker.addEventListener('click', () => arm(true))
  for (const each of swatches)
    each.addEventListener('click', () => select(each.getAttribute('aria-label') ?? ''))
  eraser.addEventListener('click', () => {
    const on = eraser.getAttribute('aria-pressed') !== 'true'
    eraser.setAttribute('aria-pressed', String(on))
    if (on) arm(false)
  })
  canvas.addEventListener('pointerdown', () => {
    if (!armed()) {
      wplace.push('paint')
      return
    }
    wplace.push('pick')
    select('Transparent')
    arm(false)
  })
  const press = (x: number, y: number) => {
    const at = { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerId: 1 }))
    canvas.dispatchEvent(new MouseEvent('click', at))
  }

  const teardown = installPicker()
  try {
    picker.click()
    redSwatch.click()
    expect([selected(), armed()]).toEqual(['Red', true])

    // An unpainted pixel has no source colour, so Wplace's own picker must answer it.
    press(5.5, 5.5)
    expect([wplace, selected(), armed()]).toEqual([['pick'], 'Transparent', false])
    press(5.5, 5.5)
    expect(wplace).toEqual(['pick', 'paint'])

    // A painted pixel is answered from source pixels, and the picker still ends.
    picker.click()
    press(1.5, 1.5)
    await vi.waitFor(() =>
      expect([armed(), eraser.getAttribute('aria-pressed')]).toEqual([false, 'false']),
    )
    expect([wplace, selected()]).toEqual([['pick', 'paint'], 'Black'])
  } finally {
    teardown()
  }
})

it('by default leaves left and middle clicks on the map to Wplace and presses no swatch', async () => {
  const white = colour('White')
  const template = await addLocalTemplate(
    {
      id: 'picker-default',
      name: 'Local template',
      source: 'wplace',
      originX: 100,
      originY: 200,
      width: 1,
      height: 1,
      indices: new Uint8Array([white.index]),
      moved: 0,
      opaque: 1,
    },
    undefined,
    true,
  )
  document.body.innerHTML = `
    <div class="maplibregl-canvas-container"><canvas></canvas></div>
    <button class="btn-primary" aria-label="Color Picker" aria-pressed="true"></button>
    <button id="color-${white.index + 1}" aria-label="White"></button>
  `
  const canvas = document.querySelector('canvas')
  const swatch = document.getElementById(`color-${white.index + 1}`)
  if (canvas === null || swatch === null) throw new Error('Missing picker fixture controls')
  const swatchClicks: boolean[] = []
  swatch.addEventListener('click', (event) => swatchClicks.push(event.isTrusted))
  const wplace: string[] = []
  for (const type of ['pointerdown', 'click', 'auxclick'])
    canvas.addEventListener(type, (event) => {
      if (!event.defaultPrevented) wplace.push(`${type}:${(event as MouseEvent).button}`)
    })

  const teardown = installPicker({})
  try {
    for (const button of [0, 1]) {
      const at = { button, clientX: 10, clientY: 10, bubbles: true, cancelable: true }
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerId: 1 }))
      canvas.dispatchEvent(new MouseEvent(button === 0 ? 'click' : 'auxclick', at))
    }
    expect(wplace).toEqual(['pointerdown:0', 'click:0', 'pointerdown:1', 'auxclick:1'])
    expect(swatchClicks).toEqual([])
  } finally {
    teardown()
    await removeLocalTemplate(template.id)
  }
})

it('keeps picking while the middle button drags only with its own switch on', async () => {
  const white = colour('White')
  const black = colour('Black')
  const template = await addLocalTemplate(
    {
      id: 'picker-drag',
      name: 'Local template',
      source: 'wplace',
      originX: 100,
      originY: 200,
      width: 2,
      height: 1,
      indices: new Uint8Array([white.index, black.index]),
      moved: 0,
      opaque: 2,
    },
    undefined,
    true,
  )
  document.body.innerHTML = `
    <div class="maplibregl-canvas-container"><canvas></canvas></div>
    <button id="color-${white.index + 1}" aria-label="White"></button>
    <button id="color-${black.index + 1}" aria-label="Black"></button>
  `
  const canvas = document.querySelector('canvas')
  if (canvas === null) throw new Error('Missing picker fixture canvas')
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(canvas)
  const pressed: string[] = []
  for (const swatch of document.querySelectorAll('button'))
    swatch.addEventListener('click', () => pressed.push(swatch.getAttribute('aria-label') ?? ''))
  // The mouse moves Wplace's world painting follows, real or forwarded by the picker.
  const moves: string[] = []
  const recordMove = (event: MouseEvent): void => {
    moves.push(`${isForwardedPaintMove(event) ? 'forwarded' : 'real'}:${event.clientX}`)
  }
  // Middle button down over White, dragged across to Black, released.
  const drag = (): void => {
    const at = { button: 1, buttons: 4, pointerId: 1, bubbles: true, cancelable: true }
    const moved = { ...at, button: -1, clientX: 30, clientY: 10 }
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, clientX: 10, clientY: 10 }))
    canvas.dispatchEvent(new PointerEvent('pointermove', moved))
    canvas.dispatchEvent(new MouseEvent('mousemove', moved))
    canvas.dispatchEvent(
      new PointerEvent('pointerup', { ...at, buttons: 0, clientX: 30, clientY: 10 }),
    )
  }

  const teardown = installPicker({ 'middle-click-pick': true })
  window.addEventListener('mousemove', recordMove)
  try {
    // One pick, and Wplace keeps following the real pointer.
    drag()
    expect(pressed).toEqual(['White'])
    expect(moves).toEqual(['real:30'])

    // Dragging picks again, and Wplace sees the picker's moves instead of the real one.
    moves.length = 0
    setState({ simulatedInput: EVERY_PICK })
    drag()
    expect(pressed).toEqual(['White', 'White', 'Black'])
    expect(moves.every((move) => move.startsWith('forwarded:'))).toBe(true)
  } finally {
    window.removeEventListener('mousemove', recordMove)
    teardown()
    await removeLocalTemplate(template.id)
  }
})
