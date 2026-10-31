import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STUDIO_LAYOUT,
  dockFrame,
  floatPlace,
  isOpen,
  movePanel,
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
  it('docks the default panels in one connected frame per edge, with Scopes closed', () => {
    expect(frames(DEFAULT_STUDIO_LAYOUT)).toEqual([
      { dock: 'start', panels: ['source', 'dimensions', 'effects'] },
      { dock: 'end', panels: ['palette', 'color-space', 'dither'] },
    ])
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
    expect(panelsIn(dockFrame(left, 'end')?.root)).toEqual(['palette', 'color-space'])

    const right = floatPlace(box(700, 100), viewport)
    expect(right).toEqual({ dock: null, edge: 'end', x: 1200 - 700 - 288, y: 100 })
  })

  it('attaches a panel beside another in any direction, or behind it as a tab', () => {
    const beside = movePanel(DEFAULT_STUDIO_LAYOUT, 'dimensions', {
      kind: 'attach',
      target: 'palette',
      zone: 'left',
    })
    expect(dockFrame(beside, 'end')?.root).toEqual({
      kind: 'split',
      axis: 'column',
      children: [
        { kind: 'split', axis: 'row', children: [tabs('dimensions'), tabs('palette')] },
        tabs('color-space'),
        tabs('dither'),
      ],
    })

    // Below a panel in a column joins that column rather than nesting another.
    const below = movePanel(DEFAULT_STUDIO_LAYOUT, 'source', {
      kind: 'attach',
      target: 'palette',
      zone: 'bottom',
    })
    expect(panelsIn(dockFrame(below, 'end')?.root)).toEqual([
      'palette',
      'source',
      'color-space',
      'dither',
    ])

    const tabbed = movePanel(DEFAULT_STUDIO_LAYOUT, 'dither', {
      kind: 'attach',
      target: 'color-space',
      zone: 'center',
    })
    expect(dockFrame(tabbed, 'end')?.root).toMatchObject({
      children: [tabs('palette'), { panels: ['color-space', 'dither'], active: 'dither' }],
    })
  })

  it('docks a panel into an edge between the panels it was dropped between', () => {
    const docked = movePanel(DEFAULT_STUDIO_LAYOUT, 'effects', {
      kind: 'dock',
      side: 'end',
      index: 1,
    })
    expect(frames(docked)).toEqual([
      { dock: 'start', panels: ['source', 'dimensions'] },
      { dock: 'end', panels: ['palette', 'effects', 'color-space', 'dither'] },
    ])
  })

  it('closes the frame a last panel leaves, and reopens a panel at the foot of its own edge', () => {
    let layout = movePanel(DEFAULT_STUDIO_LAYOUT, 'source', {
      kind: 'float',
      place: floatPlace(box(400, 100), viewport),
    })
    layout = togglePanel(layout, 'source', false)
    expect(frames(layout).map((frame) => frame.dock)).toEqual(['start', 'end'])
    expect(isOpen(layout, 'source')).toBe(false)

    layout = togglePanel(layout, 'source', true)
    expect(panelsIn(dockFrame(layout, 'start')?.root)).toEqual(['dimensions', 'effects', 'source'])
  })

  it('keeps a saved layout, and falls back to the default for one it cannot trust', () => {
    const floated = movePanel(DEFAULT_STUDIO_LAYOUT, 'dither', {
      kind: 'float',
      place: floatPlace(box(300, 100), viewport),
    })
    expect(parseStudioLayout(JSON.parse(JSON.stringify(floated)))).toEqual(floated)

    const twice = { frames: [{ place: { dock: 'start' }, root: tabs('source', 'source') }] }
    expect(parseStudioLayout(twice)).toEqual(DEFAULT_STUDIO_LAYOUT)
    // The window placements saved before frames existed.
    expect(
      parseStudioLayout({ source: { open: true, collapsed: false, dock: 'start', order: 0 } }),
    ).toEqual(DEFAULT_STUDIO_LAYOUT)
  })
})
