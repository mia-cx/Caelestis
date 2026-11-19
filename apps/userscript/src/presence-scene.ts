import type {
  PainterIdentity,
  PresencePeer,
  PresenceRect,
  RegionShapePixels,
} from '@caelestis/shared'
import { claimEditorEditingIds, claimEditorPixels } from './claim-editor.js'
import { claimsVisible, type DisplayClaim, displayClaims } from './presence-claims.js'
import { type PresenceView, presenceQuickClaims, presenceView } from './presence-client.js'
import { quickClaimPreview } from './quick-claims.js'
import { getState, type State } from './settings.js'
import { isPaintOpen } from './wplace-paint.js'

/**
 * Everything presence puts over the map, as one list: other painters' viewports and drafts, region
 * claims, quick claims, and the claim being edited. The presence layer draws it and the name tags
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

export type SceneKind = 'viewport' | 'painting' | 'draft' | 'region' | 'quick' | 'tool'

/** What an item stands for, for its name tag. */
export type SceneSource =
  | { readonly kind: 'peer'; readonly peer: PresencePeer }
  | { readonly kind: 'claim'; readonly claim: DisplayClaim }
  | { readonly kind: 'quick' }
  | { readonly kind: 'tool' }

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
  return items
}

/** The scene as the page has it now. */
export const presenceScene = (): SceneItem[] =>
  sceneItems({
    view: presenceView(),
    flags: getState(),
    paintOpen: isPaintOpen(),
    editingIds: claimEditorEditingIds(),
    quickClaims: presenceQuickClaims(),
    quickPreview: quickClaimPreview(),
    tool: claimEditorPixels()?.parts ?? [],
  })

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
  for (const listener of hoverListeners) listener()
}

export const onSceneHoverChange = (listener: () => void): void => {
  hoverListeners.push(listener)
}
