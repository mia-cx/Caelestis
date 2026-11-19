import { afterEach, describe, expect, it } from 'vitest'
import { type Anchor, anchorPopover, type PopoverPlacement } from '../src/foundations/popover.js'

afterEach(() => {
  document.body.replaceChildren()
})

const rect = (left: number, top: number, right: number, bottom: number): Anchor => ({
  left,
  top,
  right,
  bottom,
})

describe('anchorPopover', () => {
  // A 100×50 popover in Happy DOM's 1024×768 window, 8px from every edge at most.
  it.each<[string, Omit<PopoverPlacement, 'anchor'>, Anchor, { left: string; top: string }]>([
    [
      'hangs below the anchor start',
      { gap: 8 },
      rect(10, 10, 30, 30),
      { left: '10px', top: '38px' },
    ],
    [
      'lines up with the anchor end',
      { align: 'end' },
      rect(300, 10, 400, 30),
      { left: '300px', top: '30px' },
    ],
    [
      'flips above where the viewport ends',
      { gap: 8 },
      rect(10, 730, 30, 750),
      { left: '10px', top: '672px' },
    ],
    ['stays inside the right edge', {}, rect(1000, 10, 1020, 30), { left: '916px', top: '30px' }],
    [
      'sits beside the anchor',
      { side: 'beside' },
      rect(10, 100, 40, 120),
      { left: '40px', top: '100px' },
    ],
    [
      'flips to the anchor start beside the right edge',
      { side: 'beside' },
      rect(900, 100, 950, 120),
      { left: '800px', top: '100px' },
    ],
  ])('%s', (_, placement, anchor, expected) => {
    const popover = document.body.appendChild(document.createElement('div'))
    Object.defineProperty(popover, 'offsetWidth', { value: 100 })
    Object.defineProperty(popover, 'offsetHeight', { value: 50 })
    const { stop } = anchorPopover(popover, { ...placement, anchor: () => anchor })
    stop()
    expect({ left: popover.style.left, top: popover.style.top }).toEqual(expected)
  })
})
