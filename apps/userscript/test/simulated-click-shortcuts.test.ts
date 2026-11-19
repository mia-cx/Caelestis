import { afterEach, describe, expect, it, vi } from 'vitest'
import { installKeyboardShortcuts } from '../src/keyboard-shortcuts.js'
import { setState } from '../src/settings.js'

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

// An HQ editor: Wplace's alliance dialog, its artboard stage, and the same drawer controls with
// alliance swatches, which carry no ids.
const HQ_DRAWER = `
  <dialog open>
    <div role="application" aria-label="Headquarters canvas"></div>
    <section>
      <header>
        <button aria-label="Undo"></button>
        <button aria-label="Redo"></button>
        <button aria-label="Close"></button>
      </header>
      <button class="game-color-swatch" aria-pressed="true" aria-label="Black" style="background: rgb(0 0 0)"></button>
      <button class="btn btn-primary">Paint</button>
    </section>
  </dialog>`

// The bottom-centre dock button that opens the drawer.
const DOCK = `
  <div class="absolute left-1/2 -translate-x-1/2">
    <button class="btn btn-primary btn-lg">Paint</button>
  </div>`

let uninstall: (() => void) | undefined

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  setState({ simulatedInput: {} })
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

  it('submit the open draft only while its own switch is on', () => {
    const clicked = recordClicks(DRAWER)
    setState({ simulatedInput: { 'cycle-colour': true } })
    pressPaint()
    expect(clicked).toEqual([])

    setState({ simulatedInput: { 'paint-commit': true } })
    pressPaint()
    expect(clicked).toEqual(['Paint'])

    setState({ simulatedInput: {} })
    pressPaint()
    expect(clicked).toEqual(['Paint'])
  })

  it('submit an HQ draft with every switch off, since HQ checks no input', () => {
    const clicked = recordClicks(HQ_DRAWER)
    pressPaint()
    expect(clicked).toEqual(['Paint'])
  })

  it('keep each switch across a reload, and start with none', async () => {
    vi.resetModules()
    const fresh = await import('../src/settings.js')
    expect(fresh.loadState().simulatedInput).toEqual({})
    fresh.setState({ simulatedInput: { 'paint-commit': true } })

    vi.resetModules()
    const reloaded = await import('../src/settings.js')
    expect(reloaded.loadState().simulatedInput).toEqual({ 'paint-commit': true })
  })
})
