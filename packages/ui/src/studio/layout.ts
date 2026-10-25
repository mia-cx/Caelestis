import { STUDIO_WINDOWS, type StudioLayout, type StudioWindowId, type StudioWindowPlacement } from './model.js'

/** A window released this close to a screen edge docks into that edge's column. */
export const SNAP_DISTANCE = 48

/** Every window starts docked on the left, open, in Windows-menu order. */
export const defaultPlacement = (id: StudioWindowId): StudioWindowPlacement => ({
  open: true,
  collapsed: false,
  dock: 'start',
  order: STUDIO_WINDOWS.findIndex((window) => window.id === id),
})

export const placementOf = (layout: StudioLayout, id: StudioWindowId): StudioWindowPlacement =>
  layout[id] ?? defaultPlacement(id)

/** The open windows docked along one edge, top to bottom. */
export const dockedWindows = (layout: StudioLayout, side: 'start' | 'end'): StudioWindowId[] =>
  STUDIO_WINDOWS.map((window) => window.id)
    .filter((id) => {
      const placement = placementOf(layout, id)
      return placement.open && placement.dock === side
    })
    .sort((left, right) => order(layout, left) - order(layout, right))

const order = (layout: StudioLayout, id: StudioWindowId): number => {
  const placement = placementOf(layout, id)
  return placement.dock === null ? 0 : placement.order
}

/** A box in viewport pixels. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Where a dragged window lands when released at `box`. Near an edge it docks into that column,
 * above the first docked window whose middle is below its top; anywhere else it floats there,
 * measured from the nearer edge so it keeps its place when the screen resizes.
 */
export const dropWindow = (
  layout: StudioLayout,
  id: StudioWindowId,
  box: Box,
  viewport: { readonly width: number; readonly height: number },
  /** The other docked windows' boxes, by window. */
  boxes: Partial<Record<StudioWindowId, Box>>,
): StudioLayout => {
  const { open, collapsed } = placementOf(layout, id)
  const side =
    box.x <= SNAP_DISTANCE ? 'start' : box.x + box.width >= viewport.width - SNAP_DISTANCE ? 'end' : null
  if (side === null) {
    const edge = box.x + box.width / 2 < viewport.width / 2 ? 'start' : 'end'
    const x = Math.max(0, edge === 'start' ? box.x : viewport.width - box.x - box.width)
    const y = Math.min(Math.max(0, box.y), Math.max(0, viewport.height - SNAP_DISTANCE))
    return { ...layout, [id]: { open, collapsed, dock: null, edge, x, y } }
  }
  const column = dockedWindows(layout, side).filter((other) => other !== id)
  const index = column.findIndex((other) => {
    const placed = boxes[other]
    return placed !== undefined && placed.y + placed.height / 2 > box.y
  })
  column.splice(index === -1 ? column.length : index, 0, id)
  const next: Record<string, StudioWindowPlacement> = { ...layout }
  column.forEach((member, position) => {
    const placement = member === id ? { open, collapsed } : placementOf(layout, member)
    next[member] = { open: placement.open, collapsed: placement.collapsed, dock: side, order: position }
  })
  return next
}

/** Open or close a window. A reopened window keeps its last place. */
export const toggleWindow = (layout: StudioLayout, id: StudioWindowId, open: boolean): StudioLayout => ({
  ...layout,
  [id]: { ...placementOf(layout, id), open, collapsed: open ? false : placementOf(layout, id).collapsed },
})

export const collapseWindow = (layout: StudioLayout, id: StudioWindowId, collapsed: boolean): StudioLayout => ({
  ...layout,
  [id]: { ...placementOf(layout, id), collapsed },
})
