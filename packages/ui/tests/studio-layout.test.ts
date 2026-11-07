import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STUDIO_LAYOUT,
  EDGE_PLACES,
  floatPlace,
  isOpen,
  moveFrame,
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

/** Every window's edge and panels, from the back one to the front. */
const windows = (layout: StudioLayout) =>
  layout.frames.map((frame) => ({ edge: frame.place.edge, panels: panelsIn(frame.root) }))
const windowWith = (layout: StudioLayout, id: StudioWindowId) =>
  layout.frames.find((frame) => panelsIn(frame.root).includes(id))

describe('studio layout', () => {
  it('starts with Size and Dither as tabs over Colours at the start, Effects at the end, Scopes closed', () => {
    expect(windows(DEFAULT_STUDIO_LAYOUT)).toEqual([
      { edge: 'start', panels: ['dimensions', 'dither', 'palette'] },
      { edge: 'end', panels: ['effects'] },
    ])
    expect(windowWith(DEFAULT_STUDIO_LAYOUT, 'dimensions')?.root).toMatchObject({
      children: [{ panels: ['dimensions', 'dither'], active: 'dimensions' }, tabs('palette')],
    })
    expect(isOpen(DEFAULT_STUDIO_LAYOUT, 'scopes')).toBe(false)
  })

  it('floats a panel dragged out of a window as its own, measured from its nearer edge', () => {
    const left = movePanel(DEFAULT_STUDIO_LAYOUT, 'dither', {
      kind: 'float',
      place: floatPlace(box(300, 100), viewport),
    })
    expect(left.frames.at(-1)).toEqual({
      place: { edge: 'start', x: 300, y: 100 },
      root: tabs('dither'),
    })
    expect(panelsIn(windowWith(left, 'dimensions')?.root)).toEqual(['dimensions', 'palette'])

    const right = floatPlace(box(700, 100), viewport)
    expect(right).toEqual({ edge: 'end', x: 1200 - 700 - 288, y: 100 })
  })

  it('moves a whole window with every panel in it, on top of the others', () => {
    const place = floatPlace(box(500, 300), viewport)
    const moved = moveFrame(DEFAULT_STUDIO_LAYOUT, 0, { kind: 'float', place })
    expect(moved.frames.at(-1)).toEqual({ place, root: DEFAULT_STUDIO_LAYOUT.frames[0]?.root })
    expect(windows(moved).map((window) => window.panels)).toEqual([
      ['effects'],
      ['dimensions', 'dither', 'palette'],
    ])

    // Dropped on another window's panel, it joins that window.
    const joined = moveFrame(DEFAULT_STUDIO_LAYOUT, 1, {
      kind: 'attach',
      target: 'palette',
      zone: 'bottom',
    })
    expect(windows(joined)).toEqual([
      { edge: 'start', panels: ['dimensions', 'dither', 'palette', 'effects'] },
    ])
  })

  it('attaches a panel beside another in any direction, or behind it as a tab', () => {
    const beside = movePanel(DEFAULT_STUDIO_LAYOUT, 'palette', {
      kind: 'attach',
      target: 'effects',
      zone: 'left',
    })
    expect(panelsAcross(windowWith(beside, 'effects')?.root ?? tabs('effects'))).toBe(2)
    expect(windowWith(beside, 'effects')?.root).toEqual({
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
    expect(windows(below)).toEqual([
      { edge: 'start', panels: ['dimensions', 'dither', 'palette', 'effects'] },
    ])

    const tabbed = movePanel(DEFAULT_STUDIO_LAYOUT, 'effects', {
      kind: 'attach',
      target: 'palette',
      zone: 'center',
    })
    expect(windowWith(tabbed, 'palette')?.root).toMatchObject({
      children: [
        { panels: ['dimensions', 'dither'] },
        { panels: ['palette', 'effects'], active: 'effects' },
      ],
    })
  })

  it('closes the window a last panel leaves, and reopens a panel at the foot of its own edge', () => {
    let layout = togglePanel(DEFAULT_STUDIO_LAYOUT, 'effects', false)
    expect(windows(layout).map((window) => window.edge)).toEqual(['start'])
    expect(isOpen(layout, 'effects')).toBe(false)

    layout = togglePanel(layout, 'palette', false)
    layout = togglePanel(layout, 'palette', true)
    expect(windows(layout)).toEqual([
      { edge: 'start', panels: ['dimensions', 'dither', 'palette'] },
    ])

    // With no window at its edge, it opens in one of its own there.
    layout = togglePanel(layout, 'effects', true)
    expect(layout.frames.at(-1)).toEqual({ place: EDGE_PLACES.end, root: tabs('effects') })
  })

  it('keeps a saved layout, and falls back to the default for one it cannot trust', () => {
    const floated = movePanel(DEFAULT_STUDIO_LAYOUT, 'dither', {
      kind: 'float',
      place: floatPlace(box(300, 100), viewport),
    })
    expect(parseStudioLayout(JSON.parse(JSON.stringify(floated)))).toEqual(floated)

    const twice = { frames: [{ place: EDGE_PLACES.start, root: tabs('palette', 'palette') }] }
    expect(parseStudioLayout(twice)).toEqual(DEFAULT_STUDIO_LAYOUT)
    // A window docked to an edge, from before every window floated.
    expect(
      parseStudioLayout({ frames: [{ place: { dock: 'start' }, root: tabs('palette') }] }),
    ).toEqual(DEFAULT_STUDIO_LAYOUT)
  })
})
