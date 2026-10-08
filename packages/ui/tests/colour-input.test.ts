import { mount, tick, unmount } from 'svelte'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import ColourInput from '../src/appearance/ColourInput.svelte'

const mounted: object[] = []
// Happy DOM has no top layer; real popover behaviour is a browser contract, so showPopover is a
// spy and `:popover-open` only ever reports the closed side here.
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
})
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((component) => unmount(component)))
  document.body.replaceChildren()
})

describe('colour input', () => {
  // The picker stays mounted for its exit transition, so consumers that must know whether it is
  // open query `[data-caelestis-colour-picker]:popover-open`, never element existence. This pins
  // the contract: mounted-but-closed answers not-open.
  it('keeps the picker mounted while closed without matching :popover-open', async () => {
    const input = mount(ColourInput, {
      target: document.body,
      props: { label: 'Colour', value: '#ff00ff' },
    })
    mounted.push(input)
    await tick()
    expect(document.querySelector('[data-caelestis-colour-picker]')).not.toBeNull()
    expect(document.querySelector('[data-caelestis-colour-picker]:popover-open')).toBeNull()
  })
})
