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

// The territory event's bottom-centre actions, labelled only by their tooltips, as Wplace renders
// them in its main menu.
const EVENT_DOCK = `
  <div class="bottom-safe-min-3 absolute left-1/2 z-30 -translate-x-1/2">
    <div class="z-30 flex gap-2">
      <button class="btn btn-lg bg-base-100 relative" data-tooltip="Paint"><svg></svg>
        <span class="truncate max-sm:sr-only">Paint</span> <span class="tabular-nums">51/60</span>
        <span class="arena-cooldown"></span></button>
      <button class="btn btn-lg bg-base-100 relative" data-tooltip="Swap shade"><svg></svg>
        <span class="truncate max-sm:sr-only">Swap shade</span> <span class="tabular-nums">60/60</span></button>
    </div>
  </div>`

/** The event's open paint panel: a team swatch, Cancel, and the mode's commit button. */
const eventPanel = (action: string): string => `
  <div class="paint-panel relative px-3">
    <div class="pixel-instruction"><span style="background-color: rgb(14, 185, 104);"></span></div>
    <div class="paint-arena flex flex-wrap">
      <div class="flex min-w-0 flex-1"><span class="truncate">Green</span><canvas></canvas></div>
      <div class="grid shrink-0 grid-cols-2 gap-2">
        <button class="btn btn-lg sm:btn-xl">Cancel</button>
        <button class="btn btn-lg sm:btn-xl relative btn-primary"><div class="paint-button-content">
          <svg></svg> <div class="flex"><span>${action}</span> </div></div></button>
      </div>
    </div>
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
        button.id ||
          button.getAttribute('aria-label') ||
          button.dataset.tooltip ||
          `${button.textContent?.trim()}`,
      ),
    )
  uninstall?.()
  uninstall = installKeyboardShortcuts('windows-linux')
  return clicked
}

/** B, the paint key's default. */
const pressPaint = (): void => {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true }),
  )
}

/** Shift+B, the shade swap key's default. Returns whether a shortcut claimed it. */
const pressShadeSwap = (): boolean => {
  const event = new KeyboardEvent('keydown', {
    key: 'B',
    code: 'KeyB',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  })
  document.body.dispatchEvent(event)
  return event.defaultPrevented
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

  it("open the territory event's Paint and Swap shade from its own buttons", () => {
    const paint = recordClicks(EVENT_DOCK)
    pressPaint()
    expect(paint).toEqual(['Paint'])

    const swap = recordClicks(EVENT_DOCK)
    pressShadeSwap()
    expect(swap).toEqual(['Swap shade'])
  })

  it('commit an open event panel through its own action, only while the switch is on', () => {
    const paint = recordClicks(eventPanel('Paint'))
    pressPaint()
    pressShadeSwap()
    expect(paint).toEqual([])
    setState({ simulatedInput: { 'paint-commit': true } })
    pressShadeSwap()
    pressPaint()
    expect(paint).toEqual(['Paint'])

    const swap = recordClicks(eventPanel('Swap shade'))
    pressPaint()
    pressShadeSwap()
    expect(swap).toEqual(['Swap shade'])
  })

  it('leave Shift+B to Wplace off the event canvas', () => {
    const clicked = recordClicks(DOCK)
    expect(pressShadeSwap()).toBe(false)
    expect(clicked).toEqual([])
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

describe('shortcuts beside form controls', () => {
  /** B, pressed with focus inside `html`'s first input. */
  const pressPaintIn = (html: string): string[] => {
    const clicked = recordClicks(DOCK + html)
    document
      .querySelector('input')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true }))
    return clicked
  }

  it('still fire after a settings checkbox took focus', () => {
    expect(pressPaintIn('<input type="checkbox">')).toEqual(['Paint'])
  })

  it('stay out of the way while typing in a text field', () => {
    expect(pressPaintIn('<input type="text">')).toEqual([])
  })
})
