import {
  STUDIO_WINDOWS,
  type StudioFrame,
  type StudioLayout,
  type StudioNode,
  type StudioPlace,
  type StudioWindowId,
} from './model.js'

/** A panel released this close to a screen edge docks into that edge. */
export const SNAP_DISTANCE = 72

type Side = 'start' | 'end'
type Tabs = Extract<StudioNode, { kind: 'tabs' }>
export type FloatingPlace = Extract<StudioPlace, { dock: null }>

/** Where a dragged panel or frame lands. */
export type StudioDrop =
  /** Its own window. */
  | { readonly kind: 'float'; readonly place: FloatingPlace }
  /** Into an edge's frame, before its `index`th part. */
  | { readonly kind: 'dock'; readonly side: Side; readonly index: number }
  /** Beside `target`, or behind it as a tab. */
  | {
      readonly kind: 'attach'
      readonly target: StudioWindowId
      readonly zone: 'center' | 'left' | 'right' | 'top' | 'bottom'
    }

/** A box in viewport pixels. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const single = (id: StudioWindowId): Tabs => ({
  kind: 'tabs',
  panels: [id],
  active: id,
  collapsed: false,
})

/** `children` split along `axis`, merging splits along the same axis; one part needs no split. */
const joined = (axis: 'row' | 'column', children: readonly StudioNode[]): StudioNode | null => {
  const parts = children.flatMap((child) =>
    child.kind === 'split' && child.axis === axis ? child.children : [child],
  )
  if (parts.length > 1) return { kind: 'split', axis, children: parts }
  return parts[0] ?? null
}

/** The panels an edge holds by default, top to bottom. */
const defaultDock = (side: Side): StudioFrame[] => {
  const root = joined(
    'column',
    STUDIO_WINDOWS.filter((window) => window.dock === side && !('closed' in window)).map((window) =>
      single(window.id),
    ),
  )
  return root === null ? [] : [{ place: { dock: side }, root }]
}

/** Each panel docked to its own edge, Scopes closed. */
export const DEFAULT_STUDIO_LAYOUT: StudioLayout = {
  frames: [...defaultDock('start'), ...defaultDock('end')],
}

/** Every panel in `node`, in reading order. */
export const panelsIn = (node: StudioNode | undefined): StudioWindowId[] => {
  if (node === undefined) return []
  return node.kind === 'tabs' ? [...node.panels] : node.children.flatMap(panelsIn)
}

/** How many panels wide `node` lays out: side-by-side parts add up, stacked ones take the widest. */
export const panelsAcross = (node: StudioNode): number => {
  if (node.kind === 'tabs') return 1
  const widths = node.children.map(panelsAcross)
  return node.axis === 'row' ? widths.reduce((sum, width) => sum + width, 0) : Math.max(...widths)
}

export const isOpen = (layout: StudioLayout, id: StudioWindowId): boolean =>
  layout.frames.some((frame) => panelsIn(frame.root).includes(id))

export const dockFrame = (layout: StudioLayout, side: Side): StudioFrame | undefined =>
  layout.frames.find((frame) => frame.place.dock === side)

/** A floating frame at `box`, measured from its nearer edge so it keeps its place when the screen resizes. */
export const floatPlace = (
  box: Box,
  viewport: { readonly width: number; readonly height: number },
): FloatingPlace => {
  const edge = box.x + box.width / 2 < viewport.width / 2 ? 'start' : 'end'
  return {
    dock: null,
    edge,
    x: Math.max(0, edge === 'start' ? box.x : viewport.width - box.x - box.width),
    y: Math.min(Math.max(0, box.y), Math.max(0, viewport.height - SNAP_DISTANCE)),
  }
}

/** `node` without the panel `id`, or null when nothing is left. A tab closing shows its neighbour. */
const without = (node: StudioNode, id: StudioWindowId): StudioNode | null => {
  if (node.kind === 'split')
    return joined(
      node.axis,
      node.children.flatMap((child) => without(child, id) ?? []),
    )
  const at = node.panels.indexOf(id)
  if (at === -1) return node
  const panels = node.panels.filter((panel) => panel !== id)
  const neighbour = panels[Math.max(0, at - 1)]
  if (neighbour === undefined) return null
  return { ...node, panels, active: node.active === id ? neighbour : node.active }
}

/** The layout without `ids`. A frame left empty closes. */
const removing = (layout: StudioLayout, ids: readonly StudioWindowId[]): StudioLayout => ({
  frames: layout.frames.flatMap((frame) => {
    const root = ids.reduce<StudioNode | null>((node, id) => node && without(node, id), frame.root)
    return root === null ? [] : [{ ...frame, root }]
  }),
})

/** `tree` with `node` beside the tabs holding `target`, or added behind them as tabs. */
const attaching = (
  tree: StudioNode,
  node: StudioNode,
  target: StudioWindowId,
  zone: Extract<StudioDrop, { kind: 'attach' }>['zone'],
): StudioNode => {
  if (tree.kind === 'split')
    return (
      joined(
        tree.axis,
        tree.children.map((child) => attaching(child, node, target, zone)),
      ) ?? tree
    )
  if (!tree.panels.includes(target)) return tree
  if (zone === 'center') {
    const added = panelsIn(node)
    return { ...tree, panels: [...tree.panels, ...added], active: added[0] ?? tree.active }
  }
  const axis = zone === 'left' || zone === 'right' ? 'row' : 'column'
  return joined(axis, zone === 'left' || zone === 'top' ? [node, tree] : [tree, node]) ?? tree
}

/** The layout with `node`, already taken out of it, landed at `drop`. */
const placing = (layout: StudioLayout, node: StudioNode, drop: StudioDrop): StudioLayout => {
  if (drop.kind === 'float')
    return { frames: [...layout.frames, { place: drop.place, root: node }] }
  if (drop.kind === 'attach')
    return {
      frames: layout.frames.map((frame) => ({
        ...frame,
        root: attaching(frame.root, node, drop.target, drop.zone),
      })),
    }
  const frame = dockFrame(layout, drop.side)
  if (frame === undefined)
    return { frames: [...layout.frames, { place: { dock: drop.side }, root: node }] }
  const parts =
    frame.root.kind === 'split' && frame.root.axis === 'column' ? frame.root.children : [frame.root]
  const index = Math.min(Math.max(0, drop.index), parts.length)
  const root = joined('column', [...parts.slice(0, index), node, ...parts.slice(index)]) ?? node
  return { frames: layout.frames.map((other) => (other === frame ? { ...other, root } : other)) }
}

/** Move one panel out of wherever it is to `drop`. */
export const movePanel = (
  layout: StudioLayout,
  id: StudioWindowId,
  drop: StudioDrop,
): StudioLayout => {
  if (drop.kind === 'attach' && drop.target === id) return layout
  return placing(removing(layout, [id]), single(id), drop)
}

/** Move a whole frame: to another place on screen, or into a dock or beside a panel. */
export const moveFrame = (layout: StudioLayout, index: number, drop: StudioDrop): StudioLayout => {
  const frame = layout.frames[index]
  if (frame === undefined) return layout
  if (drop.kind === 'float')
    return {
      frames: layout.frames.map((other) =>
        other === frame ? { ...other, place: drop.place } : other,
      ),
    }
  if (drop.kind === 'attach' && panelsIn(frame.root).includes(drop.target)) return layout
  return placing({ frames: layout.frames.filter((other) => other !== frame) }, frame.root, drop)
}

/** Close a panel, or open it at the foot of its own edge. */
export const togglePanel = (
  layout: StudioLayout,
  id: StudioWindowId,
  open: boolean,
): StudioLayout => {
  if (open === isOpen(layout, id)) return layout
  if (!open) return removing(layout, [id])
  const side = STUDIO_WINDOWS.find((window) => window.id === id)?.dock ?? 'start'
  return placing(layout, single(id), { kind: 'dock', side, index: Number.POSITIVE_INFINITY })
}

/** The layout with the tabs holding `id` changed by `update`. */
const changingTabs = (
  layout: StudioLayout,
  id: StudioWindowId,
  update: (tabs: Tabs) => Tabs,
): StudioLayout => {
  const visit = (node: StudioNode): StudioNode =>
    node.kind === 'split'
      ? { ...node, children: node.children.map(visit) }
      : node.panels.includes(id)
        ? update(node)
        : node
  return { frames: layout.frames.map((frame) => ({ ...frame, root: visit(frame.root) })) }
}

/** Show `id` in front of its tabs. */
export const selectPanel = (layout: StudioLayout, id: StudioWindowId): StudioLayout =>
  changingTabs(layout, id, (tabs) => ({ ...tabs, active: id }))

/** Fold the tabs holding `id` down to their bar, or open them again. */
export const collapsePanel = (
  layout: StudioLayout,
  id: StudioWindowId,
  collapsed: boolean,
): StudioLayout => changingTabs(layout, id, (tabs) => ({ ...tabs, collapsed }))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const PANELS = new Set<unknown>(STUDIO_WINDOWS.map((window) => window.id))
const isPanel = (value: unknown): value is StudioWindowId => PANELS.has(value)

const parsePlace = (value: unknown): StudioPlace | null => {
  if (!isRecord(value)) return null
  const { dock, edge, x, y } = value
  if (dock === 'start' || dock === 'end') return { dock }
  if (dock !== null || (edge !== 'start' && edge !== 'end')) return null
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y))
    return null
  return { dock, edge, x: Math.max(0, x), y: Math.max(0, y) }
}

/** A saved node, with each panel at most once across `seen`, or null. */
const parseNode = (value: unknown, seen: Set<StudioWindowId>): StudioNode | null => {
  if (!isRecord(value)) return null
  if (value.kind === 'tabs') {
    const { panels, active, collapsed } = value
    if (!Array.isArray(panels) || typeof collapsed !== 'boolean' || !isPanel(active)) return null
    if (!panels.includes(active)) return null
    for (const panel of panels) {
      if (!isPanel(panel) || seen.has(panel)) return null
      seen.add(panel)
    }
    return { kind: 'tabs', panels: panels as StudioWindowId[], active, collapsed }
  }
  const { axis, children } = value
  if (value.kind !== 'split' || (axis !== 'row' && axis !== 'column')) return null
  if (!Array.isArray(children) || children.length < 2) return null
  const parts: StudioNode[] = []
  for (const child of children) {
    const part = parseNode(child, seen)
    if (part === null) return null
    parts.push(part)
  }
  return { kind: 'split', axis, children: parts }
}

/** A saved layout, or the default for anything malformed, including the layouts of older versions. */
export const parseStudioLayout = (value: unknown): StudioLayout => {
  if (!isRecord(value) || !Array.isArray(value.frames)) return DEFAULT_STUDIO_LAYOUT
  const seen = new Set<StudioWindowId>()
  const frames: StudioFrame[] = []
  for (const saved of value.frames) {
    if (!isRecord(saved)) return DEFAULT_STUDIO_LAYOUT
    const place = parsePlace(saved.place)
    const root = parseNode(saved.root, seen)
    if (place === null || root === null) return DEFAULT_STUDIO_LAYOUT
    if (place.dock !== null && dockFrame({ frames }, place.dock) !== undefined)
      return DEFAULT_STUDIO_LAYOUT
    frames.push({ place, root })
  }
  return { frames }
}
