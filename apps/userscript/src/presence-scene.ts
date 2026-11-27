import {
  type PainterIdentity,
  type PresencePeer,
  type PresenceRect,
  type RegionShapePixels,
  sameRect,
} from '@caelestis/shared'
import { captureItems } from './capture-runs.js'
import type { CaptureItem } from './capture-scene.js'
import { claimEditorEditingIds, claimEditorPixels } from './claim-editor.js'
import { notifyListeners } from './listeners.js'
import { claimsVisible, type DisplayClaim, displayClaims } from './presence-claims.js'
import { type PresenceView, presenceQuickClaims, presenceView } from './presence-client.js'
import { quickClaimPreview } from './quick-claims.js'
import { getState, type State } from './settings.js'
import { isPaintOpen } from './wplace-paint.js'

/**
 * Everything presence puts over the map, as one list: other painters' viewports and drafts, region
 * claims, quick claims, the claim being edited, and a capture run. The presence layer draws it and the name tags
 * hit-test it, so both always agree on what is there and under which id.
 */

export type SceneItemId =
  | `peer:${string}:viewport`
  | `peer:${string}:draft`
  | `region:${string}`
  | `quick:me:${number}`
  | 'quick:me:preview'
  | `quick:${string}:${number}`
  | `tool:${number}`
  | `capture:${number}`

export type SceneKind =
  | 'viewport'
  | 'painting'
  | 'draft'
  | 'region'
  | 'quick'
  | 'tool'
  | 'capture-mine'
  | 'capture-todo'
  | 'capture-ready'
  | 'capture-pending'
  | 'capture-area'
  | 'capture-anchor'
  | 'capture-demo'

/** What an item stands for, for its name tag. */
export type SceneSource =
  | { readonly kind: 'peer'; readonly peer: PresencePeer }
  | { readonly kind: 'claim'; readonly claim: DisplayClaim }
  | { readonly kind: 'quick' }
  | { readonly kind: 'tool' }
  | { readonly kind: 'capture' }

export interface SceneItem {
  readonly id: SceneItemId
  readonly kind: SceneKind
  readonly rect: PresenceRect
  readonly painter: PainterIdentity | null
  /** A draft's base64 bitmask, or a claim's pixels. */
  readonly mask: string | RegionShapePixels | null
  /** Yours: its fill steps aside under the pointer so you can see what you paint. */
  readonly mine: boolean
  /** The item that steps aside when this one is hovered: a draft's is its peer's viewport. */
  readonly aside: SceneItemId
  /** Drawn where the pointer is right now, without fading: it follows a gesture. */
  readonly follows: boolean
  readonly source: SceneSource
  /** Unit RGB that overrides the painter's colour, as a capture run's team colours do. */
  readonly colour?: readonly [number, number, number]
}

/** What the scene is built from; `presenceScene` reads it from the page. */
export interface SceneInputs {
  readonly view: PresenceView
  readonly flags: Pick<
    State,
    | 'showPresence'
    | 'showPresenceViewports'
    | 'showPresenceClaims'
    | 'showPresenceClaimsOnlyWhilePainting'
  >
  readonly paintOpen: boolean
  readonly editingIds: readonly string[]
  readonly quickClaims: readonly PresenceRect[]
  readonly quickPreview: PresenceRect | null
  readonly tool: readonly RegionShapePixels[]
  /** A capture run's lines, area, anchors and demo, or the plans an administrator is choosing from. */
  readonly capture: readonly CaptureItem[]
}

const peerItems = (peer: PresencePeer): SceneItem[] => {
  const viewport = `peer:${peer.sessionId}:viewport` as const
  const items: SceneItem[] = []
  const base = { painter: peer.painter, mine: false, follows: false, aside: viewport }
  const source = { kind: 'peer', peer } as const
  if (peer.viewport !== null)
    items.push({
      ...base,
      id: viewport,
      kind: peer.draft === null ? 'viewport' : 'painting',
      rect: peer.viewport,
      mask: null,
      source,
    })
  if (peer.draft !== null)
    items.push({
      ...base,
      id: `peer:${peer.sessionId}:draft`,
      kind: 'draft',
      rect: peer.draft.rect,
      mask: peer.draft.mask ?? null,
      source,
    })
  return items
}

const quickItem = (
  id: SceneItemId,
  rect: PresenceRect,
  painter: PainterIdentity | null,
  mine: boolean,
  follows = false,
): SceneItem => ({
  id,
  kind: 'quick',
  rect,
  painter,
  mask: null,
  mine,
  aside: id,
  follows,
  source: { kind: 'quick' },
})

/** The scene from explicit inputs, with every visibility rule applied once, here. */
export const sceneItems = (inputs: SceneInputs): SceneItem[] => {
  const { view, flags } = inputs
  const claimsShown = claimsVisible(flags, inputs.paintOpen)
  const items: SceneItem[] =
    flags.showPresence && flags.showPresenceViewports ? view.peers.flatMap(peerItems) : []
  // Keep complete display unions, including offscreen members, but skip hidden preparation.
  for (const claim of claimsShown ? displayClaims(view.regions, inputs.editingIds) : []) {
    const id = `region:${claim.id}` as const
    items.push({
      id,
      kind: 'region',
      rect: claim.pixels.rect,
      painter: claim.regions[0].claimant,
      mask: claim.pixels,
      mine: view.me !== null && claim.regions[0].claimant.wplaceUserId === view.me.wplaceUserId,
      aside: id,
      follows: false,
      source: { kind: 'claim', claim },
    })
  }
  // Your quick claims show while you paint; the one being dragged follows the pointer.
  for (const [index, rect] of inputs.quickClaims.entries())
    items.push(quickItem(`quick:me:${index}`, rect, view.me, true))
  if (inputs.quickPreview !== null)
    items.push(quickItem('quick:me:preview', inputs.quickPreview, view.me, false, true))
  if (claimsShown)
    for (const peer of view.peers)
      for (const [index, rect] of (peer.quickClaims ?? []).entries())
        items.push(quickItem(`quick:${peer.sessionId}:${index}`, rect, peer.painter, false))
  // The editor's own claim shows even with other painters hidden; it is the user's own work.
  for (const [index, pixels] of inputs.tool.entries()) {
    const id = `tool:${index}` as const
    items.push({
      id,
      kind: 'tool',
      rect: pixels.rect,
      painter: view.me,
      mask: pixels,
      mine: false,
      aside: id,
      follows: true,
      source: { kind: 'tool' },
    })
  }
  // A capture run's lines show whatever the visibility switches say: the run needs them seen.
  for (const [index, item] of inputs.capture.entries()) {
    const id = `capture:${index}` as const
    items.push({
      id,
      kind: `capture-${item.kind}`,
      rect: item.rect,
      painter: null,
      ...(item.colour === null ? {} : { colour: item.colour }),
      mask: item.pixels,
      mine: item.kind === 'mine' || item.kind === 'todo',
      aside: id,
      // The demo moves every step; the fade would smear it.
      follows: item.kind === 'demo',
      source: { kind: 'capture' },
    })
  }
  return items
}

const NO_TOOL: readonly RegionShapePixels[] = []

/** Whether two inputs build the same scene: the same sources, unchanged. */
const sameInputs = (left: SceneInputs, right: SceneInputs): boolean =>
  left.view.peers === right.view.peers &&
  left.view.regions === right.view.regions &&
  left.view.me === right.view.me &&
  left.flags.showPresence === right.flags.showPresence &&
  left.flags.showPresenceViewports === right.flags.showPresenceViewports &&
  left.flags.showPresenceClaims === right.flags.showPresenceClaims &&
  left.flags.showPresenceClaimsOnlyWhilePainting ===
    right.flags.showPresenceClaimsOnlyWhilePainting &&
  left.paintOpen === right.paintOpen &&
  left.editingIds === right.editingIds &&
  left.quickClaims === right.quickClaims &&
  sameRect(left.quickPreview, right.quickPreview) &&
  left.tool === right.tool &&
  left.capture === right.capture

let built: { readonly inputs: SceneInputs; readonly items: readonly SceneItem[] } | null = null

/**
 * The scene as the page has it now. The layer and the name tags both ask every frame, and peers
 * move only a few times a second, so the last scene is returned again, the same array, until one
 * of its sources changes.
 */
export const presenceScene = (): readonly SceneItem[] => {
  const state = getState()
  const inputs: SceneInputs = {
    view: presenceView(),
    // Copied out: the scene depends on these four, not on the rest of the state.
    flags: {
      showPresence: state.showPresence,
      showPresenceViewports: state.showPresenceViewports,
      showPresenceClaims: state.showPresenceClaims,
      showPresenceClaimsOnlyWhilePainting: state.showPresenceClaimsOnlyWhilePainting,
    },
    paintOpen: isPaintOpen(),
    editingIds: claimEditorEditingIds(),
    quickClaims: presenceQuickClaims(),
    quickPreview: quickClaimPreview(),
    tool: claimEditorPixels()?.parts ?? NO_TOOL,
    capture: captureItems(),
  }
  if (built === null || !sameInputs(built.inputs, inputs))
    built = { inputs, items: sceneItems(inputs) }
  return built.items
}

let motion: ((id: SceneItemId) => PresenceRect | null) | null = null

/** The drawer reports where it shows an item mid-glide, so tags follow the motion. */
export const setSceneMotion = (displayed: (id: SceneItemId) => PresenceRect | null): void => {
  motion = displayed
}

/** Where an item is drawn right now. */
export const displayedRect = (item: SceneItem): PresenceRect => motion?.(item.id) ?? item.rect

let hovered: ReadonlySet<SceneItemId> = new Set()
const hoverListeners: (() => void)[] = []

/** The items whose fill steps aside because the pointer rests on them. */
export const hoveredSceneItems = (): ReadonlySet<SceneItemId> => hovered

/** Replace the hovered set; listeners run only when it actually changed. */
export const setHoveredSceneItems = (ids: ReadonlySet<SceneItemId>): void => {
  if (ids.size === hovered.size && [...ids].every((id) => hovered.has(id))) return
  hovered = new Set(ids)
  notifyListeners(hoverListeners, 'presence hover listener failed')
}

export const onSceneHoverChange = (listener: () => void): void => {
  hoverListeners.push(listener)
}
