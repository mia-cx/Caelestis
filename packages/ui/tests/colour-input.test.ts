import { mount, tick, unmount } from 'svelte'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import ColourInput from '../src/appearance/ColourInput.svelte'

// Happy DOM has no top layer; real popover behaviour is a browser contract, so the popover API is
// stubbed and only the component's own reporting is asserted.
const showPopover = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover')
const hidePopover = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidePopover')
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'showPopover', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value: vi.fn(),
  })
})
afterAll(() => {
  if (showPopover !== undefined)
    Object.defineProperty(HTMLElement.prototype, 'showPopover', showPopover)
  else Reflect.deleteProperty(HTMLElement.prototype, 'showPopover')
  if (hidePopover !== undefined)
    Object.defineProperty(HTMLElement.prototype, 'hidePopover', hidePopover)
  else Reflect.deleteProperty(HTMLElement.prototype, 'hidePopover')
  document.body.replaceChildren()
})

describe('colour input', () => {
  it('reports opening and closing, and commits a held arrow key once', async () => {
    const events: string[] = []
    const input = mount(ColourInput, {
      target: document.body,
      props: {
        label: 'Colour',
        value: '#ff00ff',
        onOpenChange: (open: boolean) => events.push(open ? 'open' : 'close'),
        onPreview: () => events.push('preview'),
        onCommit: () => events.push('commit'),
      },
    })
    await tick()
    const swatch = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
    swatch?.click()
    await tick()
    const square = document.querySelector<HTMLElement>('[role="slider"]')
    for (let i = 0; i < 3; i++) {
      square?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    }
    square?.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
    expect(events).toEqual(['open', 'preview', 'preview', 'preview', 'commit'])

    swatch?.click()
    expect(events.at(-1)).toBe('close')

    swatch?.click()
    await tick()
    await unmount(input)
    expect(events.slice(-2)).toEqual(['open', 'close'])
  })
})
