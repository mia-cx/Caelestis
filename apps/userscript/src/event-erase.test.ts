import { afterEach, expect, it, vi } from 'vitest'
import { installEventErase } from './event-erase.js'
import { setState } from './settings.js'

vi.mock('./alliance-editor-dom.js', () => ({
  activeAllianceEditorStage: () => null,
  activeAllianceDialog: () => null,
}))

afterEach(() => {
  localStorage.clear()
  setState({ simulatedInput: {} })
  document.body.replaceChildren()
})

/** Wplace's territory event Paint panel, which has no eraser control of its own. */
const openEventPanel = (): HTMLCanvasElement => {
  document.body.innerHTML = `
    <canvas class="maplibregl-canvas" style="cursor: var(--cursor-pencil)"></canvas>
    <div class="paint-arena">
      <div>Green 60/60</div>
      <div class="grid"><button>Cancel</button><button>Paint</button></div>
    </div>`
  return document.querySelector('canvas') as HTMLCanvasElement
}

const eraseButton = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Eraser"]')

it("presses Wplace's eraser key from the event panel only while its switch is on", async () => {
  installEventErase()
  const canvas = openEventPanel()
  setState({ simulatedInput: {} })
  expect(eraseButton()).toBeNull()

  setState({ simulatedInput: { 'event-erase': true } })
  const button = eraseButton()
  expect(button?.nextElementSibling?.textContent).toBe('CancelPaint')
  expect(button?.getAttribute('aria-pressed')).toBe('false')

  const keys: string[] = []
  document.addEventListener('keydown', (event) => keys.push(event.code))
  button?.click()
  expect(keys).toEqual(['KeyE'])

  // Wplace answers the key by switching its tool, which it shows as the map's cursor.
  canvas.style.cursor = 'var(--cursor-eraser)'
  await Promise.resolve()
  expect(button?.getAttribute('aria-pressed')).toBe('true')

  canvas.style.cursor = 'var(--cursor-pencil)'
  await Promise.resolve()
  setState({ simulatedInput: {} })
  expect(eraseButton()).toBeNull()
})

it('stays until the painter leaves an eraser it turned on, after its switch goes off', async () => {
  installEventErase()
  const canvas = openEventPanel()
  setState({ simulatedInput: { 'event-erase': true } })
  const keys: string[] = []
  document.addEventListener('keydown', (event) => keys.push(event.code))
  eraseButton()?.click()
  canvas.style.cursor = 'var(--cursor-eraser)'
  await Promise.resolve()

  setState({ simulatedInput: {} })
  expect(keys).toEqual(['KeyE'])
  eraseButton()?.click()
  expect(keys).toEqual(['KeyE', 'KeyE'])
  canvas.style.cursor = 'var(--cursor-pencil)'
  await Promise.resolve()
  expect(eraseButton()).toBeNull()
})

it("presses the painter's own eraser key, and hides when only a mouse button erases", () => {
  installEventErase()
  openEventPanel()
  const keys: KeyboardEvent[] = []
  document.addEventListener('keydown', (event) => keys.push(event))
  localStorage.setItem(
    'wplace:controls:v1',
    JSON.stringify({ bindings: { 'paint.eraser': ['MouseBack', 'Shift+X'] } }),
  )
  setState({ simulatedInput: { 'event-erase': true } })
  eraseButton()?.click()
  expect(keys.map(({ code, key, shiftKey }) => ({ code, key, shiftKey }))).toEqual([
    { code: 'KeyX', key: 'X', shiftKey: true },
  ])

  localStorage.setItem(
    'wplace:controls:v1',
    JSON.stringify({ bindings: { 'paint.eraser': ['MouseBack'] } }),
  )
  setState({ simulatedInput: {} })
  setState({ simulatedInput: { 'event-erase': true } })
  expect(eraseButton()).toBeNull()
})
