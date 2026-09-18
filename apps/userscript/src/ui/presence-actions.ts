import {
  type PresencePeer,
  type PresenceRect,
  type RegionClaim,
  type RegionDocument,
  rectCentreDistance,
  rectIntersection,
  regionDocumentBounds,
  sameTemplateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type {
  ClaimRowModel,
  ClaimTool,
  PainterRowModel,
  PresenceSummaryModel,
} from '@caelestis/ui/elements'
import { claimDocumentPixels, claimDocuments } from '../claim-document.js'
import {
  type ClaimEditorHost,
  installClaimEditor,
  isClaimModeActive,
  startClaimMode,
} from '../claim-editor.js'
import { claimRouter } from '../claim-routing.js'
import { type PresenceView, presenceServers, presenceView } from '../presence-client.js'
import { presenceCss } from '../presence-colour.js'
import { activeServerToken, type ConnectedServer } from '../state.js'
import { isServerTemplate, localTemplates, type PlacedTemplate } from '../templates/local-store.js'
import { navigateTo } from '../templates/navigate.js'
import { toast } from './toast.js'

/**
 * The Painters drawer and region claims, from the drawer, the rail, and the keyboard.
 *
 * The drawer lists everyone presence knows about, with a Fly to that goes to where they were last
 * seen, and every region claim, with a Fly to that frames it. The editor owns drawing; the claim
 * router owns persistence and server recipients.
 */

interface ClaimTarget {
  readonly template: PlacedTemplate
  readonly server: ConnectedServer
}

const pending = false
let message: string | undefined
let rerenderPanel: (() => void) | null = null

const templateRect = (template: PlacedTemplate): PresenceRect => ({
  x: template.originX,
  y: template.originY,
  w: template.width,
  h: template.height,
})

/** The server template overlapping `rect` whose overlap is centred nearest to it. */
const targetFor = (rect: PresenceRect | null): ClaimTarget | null => {
  if (rect === null) return null
  let best: ClaimTarget | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const template of localTemplates()) {
    if (
      !isServerTemplate(template) ||
      template.serverConnection === undefined ||
      !sameTemplateSurface(template.surface ?? WORLD_TEMPLATE_SURFACE, WORLD_TEMPLATE_SURFACE)
    )
      continue
    const overlap = rectIntersection(rect, templateRect(template))
    if (overlap === null) continue
    const distance = rectCentreDistance(overlap, rect)
    if (distance < bestDistance) {
      bestDistance = distance
      best = { template, server: template.serverConnection }
    }
  }
  return best
}

/** Pixel counts per document, so a list never rasterises a claim just to label it. */
const pixelCounts = new WeakMap<RegionDocument, number>()

/** A short description of a document for lists and toasts. */
export const documentName = (document: RegionDocument): string => {
  const count = document.items.length
  let pixels = pixelCounts.get(document)
  if (pixels === undefined) {
    pixels = claimDocuments(document).reduce(
      (total, part) => total + (claimDocumentPixels(part)?.count ?? 0),
      0,
    )
    pixelCounts.set(document, pixels)
  }
  const first = document.items[0]?.shape.kind ?? 'shape'
  const kind = count === 1 ? first : `${count} shapes`
  return `${kind} · ${pixels.toLocaleString()} px`
}

/**
 * Where a painter is right now, for Fly to: their drafted pixels, else their viewport. Null when
 * they have left or have not shared a viewport.
 */
export const painterLocation = (view: PresenceView, sessionId: string): PresenceRect | null => {
  const peer = view.peers.find((held) => held.sessionId === sessionId)
  return peer === undefined ? null : (peer.draft?.rect ?? peer.viewport)
}

/** Painting first, then browsing, then those who have not shared a viewport. */
const rank = (peer: PresencePeer): number =>
  peer.draft !== null ? 0 : peer.viewport !== null ? 1 : 2

/**
 * The unique nearby sessions received across all connected servers, ordered for the drawer.
 */
const painterRows = (view: PresenceView): PainterRowModel[] =>
  [...view.peers]
    .sort(
      (left, right) =>
        rank(left) - rank(right) ||
        left.painter.displayName.localeCompare(right.painter.displayName),
    )
    .map((peer) => ({
      key: peer.sessionId,
      name: peer.painter.displayName,
      userId: peer.painter.wplaceUserId,
      colour: presenceCss(peer.painter.wplaceUserId),
      activity:
        peer.draft !== null
          ? `painting ${peer.draft.pixels.toLocaleString()} px`
          : peer.viewport !== null
            ? 'browsing'
            : 'online',
      canFly: peer.draft !== null || peer.viewport !== null,
    }))

/** A claim the map can fly to: on the world surface and for a season a connected server holds. */
const flyable = (region: RegionClaim): boolean =>
  sameTemplateSurface(region.surface, WORLD_TEMPLATE_SURFACE) &&
  presenceServers().some((server) => server.season === region.season)

/**
 * Every claim worth listing, mine first. Mine merge the router, so a claim still on its way to a
 * server is already here, with the presence snapshot, so a claim made in another browser or one the
 * local store has not adopted yet is here too. Everyone else's come from the snapshot alone.
 */
const knownClaims = (view: PresenceView): { mine: RegionClaim[]; others: RegionClaim[] } => {
  const me = view.me?.wplaceUserId
  const owned = new Map<string, RegionClaim>()
  for (const region of claimRouter().mine()) owned.set(region.id, region)
  for (const region of view.regions)
    if (me !== undefined && region.claimant.wplaceUserId === me && !owned.has(region.id))
      owned.set(region.id, region)
  const mine = [...owned.values()]
    .filter(flyable)
    .sort((left, right) => right.createdAt - left.createdAt)
  const others = view.regions
    .filter((region) => flyable(region) && region.claimant.wplaceUserId !== me)
    .sort(
      (left, right) =>
        left.claimant.displayName.localeCompare(right.claimant.displayName) ||
        right.createdAt - left.createdAt,
    )
  return { mine, others }
}

const claimRows = (view: PresenceView): ClaimRowModel[] => {
  const { mine, others } = knownClaims(view)
  const row = (region: RegionClaim, isMine: boolean): ClaimRowModel => ({
    key: region.id,
    name: isMine ? 'You' : region.claimant.displayName,
    userId: region.claimant.wplaceUserId,
    colour: presenceCss(region.claimant.wplaceUserId),
    description: documentName(region.document),
    mine: isMine,
  })
  return [...mine.map((region) => row(region, true)), ...others.map((region) => row(region, false))]
}

/** What the drawer shows: headcount, the painters, and whether the claim tool can open. */
export const presenceSummaryModel = (): PresenceSummaryModel | undefined => {
  const view = presenceView()
  // Without the socket there is nobody to list and nothing to claim, so the drawer stays away.
  if (!view.connected) return undefined
  const me = view.me
  return {
    online: view.online,
    connected: view.connected,
    players: painterRows(view),
    claims: claimRows(view),
    canClaim: me !== null && view.connected && !isClaimModeActive(),
    ...(pending ? { pending: true } : {}),
    ...(message === undefined ? {} : { message }),
  }
}

/**
 * Take the map to where a painter is. Presence is read again here, not from the rendered row,
 * so someone who left between render and click gets a toast, not a stale flight.
 */
export const flyToPainter = (sessionId: string): boolean => {
  const rect = painterLocation(presenceView(), sessionId)
  if (rect === null) {
    toast('That painter is no longer here.', 'error')
    return false
  }
  navigateTo({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, width: rect.w, height: rect.h })
  return true
}

/**
 * Take the map to a claim. Claims are read again here, not from the rendered row, so one that
 * was released or expired between render and click gets a toast, not a flight to nothing.
 */
export const flyToClaim = (id: string): boolean => {
  const { mine, others } = knownClaims(presenceView())
  const region = [...mine, ...others].find((held) => held.id === id)
  if (region === undefined) {
    toast('That claim is no longer here.', 'error')
    return false
  }
  const rect = region.rect
  navigateTo({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, width: rect.w, height: rect.h })
  return true
}

const host = (): ClaimEditorHost => ({
  templateFor: (document) => targetFor(regionDocumentBounds(document))?.template.name ?? null,
  myRegions: () =>
    claimRouter()
      .mine()
      .filter(
        (region) =>
          sameTemplateSurface(region.surface, WORLD_TEMPLATE_SURFACE) &&
          presenceServers().some((server) => server.season === region.season),
      )
      .map((region) => ({ id: region.id, document: region.document })),
  save: async (ids, documents) => {
    const result = await claimRouter().saveAll(ids, documents)
    if (result.error === null && documents.length > 0)
      toast(
        `Saved your regions: ${documentName({ items: documents.flatMap((document) => document.items) })}.`,
      )
    return result
  },
  changed: () => rerenderPanel?.(),
})

/** Wire the editor to this module once, before anything can open it. */
export const installClaimToolHost = (): void => {
  installClaimEditor(host())
}

const ready = (): boolean => {
  const view = presenceView()
  const servers = presenceServers()
  const seasonsAgree =
    new Set(
      servers.filter((server) => activeServerToken(server) !== null).map((server) => server.season),
    ).size === 1
  const server = servers.find((server) => activeServerToken(server) !== null) ?? servers[0]
  const token = server === undefined ? null : activeServerToken(server)
  if (view.connected && view.me !== null && token !== null && seasonsAgree) return true
  message =
    view.me === null
      ? 'Sign in to Wplace to claim regions.'
      : !view.connected || server === undefined
        ? 'Connect to a server that supports painter presence to claim regions.'
        : !seasonsAgree
          ? 'Connect servers for the same season, then retry.'
          : `Add your access token for ${server.info?.name ?? server.url} to claim regions.`
  toast(message, 'error')
  rerenderPanel?.()
  return false
}

/** Enter claim mode with a tool in hand, from the rail, the drawer, or the M key. */
export const openClaimTool = (tool?: ClaimTool, rerender?: () => void): boolean => {
  if (rerender !== undefined) rerenderPanel = rerender
  if (!ready()) return false
  message = undefined
  installClaimEditor(host())
  startClaimMode(tool)
  return true
}
