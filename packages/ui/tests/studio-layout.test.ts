import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STUDIO_LAYOUT,
  dockFrame,
  floatPlace,
  isOpen,
  movePanel,
  panelsAcross,
  panelsIn,
  parseStudioLayout,
  togglePanel,
} from '../src/studio/layout.js'
import type { StudioLayout, StudioNode, StudioWindowId } from '../src/studio/model.js'

const viewport = { width: 1200, height: 800 }
const box = (x: number, y: number) => ({ x, y, width: 288, height: 200 })
const tabs = (first: StudioWindowId, ...rest: StudioWindowId[]): StudioNode => ({
  kind: 'tabs',
  panels: [first, ...rest],
  active: first,
  collapsed: false,
})

/** Every frame's place and panels, in reading order. */
const frames = (layout: StudioLayout) =>
  layout.frames.map((frame) => ({ dock: frame.place.dock, panels: panelsIn(frame.root) }))

describe('studio layout', () => {
  it('docks Size and Dither as tabs over Colours at the start, Effects at the end, Scopes closed', () => {
    expect(frames(DEFAULT_STUDIO_LAYOUT)).toEqual([
      { dock: 'start', panels: ['dimensions', 'dither', 'palette'] },
      { dock: 'end', panels: ['effects'] },
    ])
    expect(dockFrame(DEFAULT_STUDIO_LAYOUT, 'start')?.root).toMatchObject({
      children: [{ panels: ['dimensions', 'dither'], active: 'dimensions' }, tabs('palette')],
    })
    expect(isOpen(DEFAULT_STUDIO_LAYOUT, 'scopes')).toBe(false)
  })

  it('floats a panel dragged out of a dock as its own window, measured from its nearer edge', () => {
    const left = movePanel(DEFAULT_STUDIO_LAYOUT, 'dither', {
      kind: 'float',
      place: floatPlace(box(300, 100), viewport),
    })
    expect(left.frames.at(-1)).toEqual({
      place: { dock: null, edge: 'start', x: 300, y: 100 },
      root: tabs('dither'),
    })
    expect(panelsIn(dockFrame(left, 'start')?.root)).toEqual(['dimensions', 'palette'])

    const right = floatPlace(box(700, 100), viewport)
    expect(right).toEqual({ dock: null, edge: 'end', x: 1200 - 700 - 288, y: 100 })
  })

  it('attaches a panel beside another in any direction, or behind it as a tab', () => {
    const beside = movePanel(DEFAULT_STUDIO_LAYOUT, 'palette', {
      kind: 'attach',
      target: 'effects',
      zone: 'left',
    })
    expect(panelsAcross(dockFrame(beside, 'end')?.root ?? tabs('effects'))).toBe(2)
    expect(dockFrame(beside, 'end')?.root).toEqual({
      kind: 'split',
      axis: 'row',
      children: [tabs('palette'), tabs('effects')],
    })

    // Below a panel in a column joins that column rather than nesting another.
    const below = movePanel(DEFAULT_STUDIO_LAYOUT, 'effects', {
      kind: 'attach',
      target: 'palette',
      zone: 'bottom',
    })
    expect(panelsIn(dockFrame(below, 'start')?.root)).toEqual([
      'dimensions',
      'dither',
      'palette',
      'effects',
    ])

    const tabbed = movePanel(DEFAULT_STUDIO_LAYOUT, 'effects', {
      kind: 'attach',
      target: 'palette',
      zone: 'center',
    })
    expect(dockFrame(tabbed, 'start')?.root).toMatchObject({
      children: [
        { panels: ['dimensions', 'dither'] },
        { panels: ['palette', 'effects'], active: 'effects' },
      ],
    })
  })

  it('moves a whole group of tabs together, keeping which one is in front', () => {
    const moved = movePanel(
      DEFAULT_STUDIO_LAYOUT,
      'dither',
      { kind: 'dock', side: 'end', index: 1 },
      true,
    )
    expect(frames(moved)).toEqual([
      { dock: 'start', panels: ['palette'] },
      { dock: 'end', panels: ['effects', 'dimensions', 'dither'] },
    ])
    expect(dockFrame(moved, 'end')?.root).toMatchObject({
      children: [tabs('effects'), { panels: ['dimensions', 'dither'], active: 'dimensions' }],
    })
  })

  it('docks a panel into an edge between the panels it was dropped between', () => {
    const docked = movePanel(DEFAULT_STUDIO_LAYOUT, 'effects', {
      kind: 'dock',
      side: 'start',
      index: 1,
    })
    expect(frames(docked)).toEqual([
      { dock: 'start', panels: ['dimensions', 'dither', 'effects', 'palette'] },
    ])
  })

  it('closes the frame a last panel leaves, and reopens a panel at the foot of its own edge', () => {
    let layout = movePanel(DEFAULT_STUDIO_LAYOUT, 'palette', {
      kind: 'float',
      place: floatPlace(box(400, 100), viewport),
    })
    layout = togglePanel(layout, 'palette', false)
    expect(frames(layout).map((frame) => frame.dock)).toEqual(['start', 'end'])
    expect(isOpen(layout, 'palette')).toBe(false)

    layout = togglePanel(layout, 'effects', false)
    expect(frames(layout).map((frame) => frame.dock)).toEqual(['start'])

    layout = togglePanel(layout, 'palette', true)
    expect(panelsIn(dockFrame(layout, 'start')?.root)).toEqual(['dimensions', 'dither', 'palette'])
  })

  it('keeps a saved layout, and falls back to the default for one it cannot trust', () => {
    const floated = movePanel(DEFAULT_STUDIO_LAYOUT, 'dither', {
      kind: 'float',
      place: floatPlace(box(300, 100), viewport),
    })
    expect(parseStudioLayout(JSON.parse(JSON.stringify(floated)))).toEqual(floated)

    const twice = { frames: [{ place: { dock: 'start' }, root: tabs('palette', 'palette') }] }
    expect(parseStudioLayout(twice)).toEqual(DEFAULT_STUDIO_LAYOUT)
    // The window placements saved before frames existed.
    expect(
      parseStudioLayout({ source: { open: true, collapsed: false, dock: 'start', order: 0 } }),
    ).toEqual(DEFAULT_STUDIO_LAYOUT)
  })
})
