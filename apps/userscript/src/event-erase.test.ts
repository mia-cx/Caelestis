import { afterEach, expect, it, vi } from 'vitest'
import { installEventErase } from './event-erase.js'
import { setState } from './settings.js'

vi.mock('./alliance-editor-dom.js', () => ({
  activeAllianceEditorStage: () => null,
  activeAllianceDialog: () => null,
}))

afterEach(() => {
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

  setState({ simulatedInput: {} })
  expect(eraseButton()).toBeNull()
})
