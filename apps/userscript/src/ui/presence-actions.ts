import {
  type PresencePeer,
  type PresenceRect,
  type RegionDocument,
  rectCentreDistance,
  rectIntersection,
  regionDocumentBounds,
  regionDocumentPixels,
  sameTemplateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type { ClaimTool, PainterRowModel, PresenceSummaryModel } from '@caelestis/ui/elements'
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
 * seen. The editor owns drawing; the claim router owns persistence and server recipients.
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
    pixels = regionDocumentPixels(document)?.count ?? 0
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
  save: async (id, document) => {
    const error = await claimRouter().save(id, document)
    if (error === null) toast(`Saved your regions: ${documentName(document)}.`)
    return error
  },
  remove: (id) => claimRouter().remove(id),
  changed: () => rerenderPanel?.(),
})

/** Wire the editor to this module once, before anything can open it. */
export const installClaimToolHost = (): void => {
  installClaimEditor(host())
}

const ready = (): boolean => {
  const view = presenceView()
  const servers = presenceServers()
  const server = servers.find((server) => activeServerToken(server) !== null) ?? servers[0]
  const token = server === undefined ? null : activeServerToken(server)
  if (
    view.connected &&
    view.me !== null &&
    token !== null &&
    new Set(servers.map((server) => server.season)).size === 1
  )
    return true
  message =
    view.me === null
      ? 'Sign in to Wplace to claim regions.'
      : !view.connected || server === undefined
        ? 'Connect to a server that supports painter presence to claim regions.'
        : new Set(servers.map((server) => server.season)).size !== 1
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
