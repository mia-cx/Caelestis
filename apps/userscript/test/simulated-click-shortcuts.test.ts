import { afterEach, describe, expect, it, vi } from 'vitest'
import { installKeyboardShortcuts } from '../src/keyboard-shortcuts.js'
import { setState } from '../src/state.js'

// Wplace's paint drawer: history controls, two world swatches, and its Paint button.
const DRAWER = `
  <section>
    <header>
      <button aria-label="Undo"></button>
      <button aria-label="Redo"></button>
      <button aria-label="Close"></button>
    </header>
    <button id="color-1" aria-label="Black" class="ring-primary"></button>
    <button id="color-2" aria-label="Dark Gray"></button>
    <button class="btn btn-primary">Paint</button>
  </section>`

// The bottom-centre dock button that opens the drawer.
const DOCK = `
  <div class="absolute left-1/2 -translate-x-1/2">
    <button class="btn btn-primary btn-lg">Paint</button>
  </div>`

let uninstall: (() => void) | undefined

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  setState({ simulatedClickShortcuts: false })
  document.body.replaceChildren()
})

/** Every click Wplace's controls receive, named by id or label. */
const recordClicks = (html: string): string[] => {
  document.body.innerHTML = html
  const clicked: string[] = []
  for (const button of document.querySelectorAll('button'))
    button.addEventListener('click', () =>
      clicked.push(
        button.id || button.getAttribute('aria-label') || `${button.textContent?.trim()}`,
      ),
    )
  uninstall?.()
  uninstall = installKeyboardShortcuts(() => {}, 'windows-linux')
  return clicked
}

/** B, the paint key's default. */
const pressPaint = (): void => {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true }),
  )
}

describe('shortcuts that click Wplace controls', () => {
  it('open the drawer but leave its Paint button alone by default', () => {
    const closed = recordClicks(DOCK)
    pressPaint()
    expect(closed).toEqual(['Paint'])

    const open = recordClicks(DRAWER)
    pressPaint()
    expect(open).toEqual([])
  })

  it('submit the open draft once Simulated clicks is on, and stop again when it is off', () => {
    const clicked = recordClicks(DRAWER)
    setState({ simulatedClickShortcuts: true })
    pressPaint()
    expect(clicked).toEqual(['Paint'])

    setState({ simulatedClickShortcuts: false })
    pressPaint()
    expect(clicked).toEqual(['Paint'])
  })

  it('keep the opt-in across a reload, and start without it', async () => {
    vi.resetModules()
    const fresh = await import('../src/state.js')
    expect(fresh.loadState().simulatedClickShortcuts).toBe(false)
    fresh.setState({ simulatedClickShortcuts: true })

    vi.resetModules()
    const reloaded = await import('../src/state.js')
    expect(reloaded.loadState().simulatedClickShortcuts).toBe(true)
  })
})
