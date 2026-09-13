import {
  type PresenceRect,
  type RegionClaim,
  type RegionDocument,
  rectCentreDistance,
  rectIntersection,
  regionDocumentBounds,
  regionDocumentPixels,
  sameTemplateSurface,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type { ClaimTool, PainterRowModel, PresenceSummaryModel } from '@caelestis/ui/elements'
import {
  type ClaimEditorHost,
  installClaimEditor,
  isClaimModeActive,
  startClaimMode,
} from '../claim-editor.js'
import {
  claimRegion,
  type PresenceView,
  presenceLiveServer,
  presenceRegionServer,
  presenceServers,
  presenceView,
  releaseRegion,
} from '../presence-client.js'
import { presenceCss } from '../presence-colour.js'
import { activeServerToken, type ConnectedServer } from '../state.js'
import { isServerTemplate, localTemplates, type PlacedTemplate } from '../templates/local-store.js'
import { navigateTo } from '../templates/navigate.js'
import { accountIdentity } from '../wplace-account.js'
import { toast } from './toast.js'

/**
 * The Painters drawer and region claims, from the drawer, the rail, and the keyboard.
 *
 * The drawer lists everyone presence knows about, with a Fly to that goes to where they were last
 * seen. The editor owns drawing; this module owns what a claim means: which server it is saved
 * to, which template it happens to overlap, and how a saved claim comes back for editing.
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

const serverFor = (region: RegionClaim): ConnectedServer | undefined =>
  presenceRegionServer(region.id) ?? undefined

/**
 * The one server claim mode edits: the one carrying the presence socket, else the first that
 * supports claims. Your regions there load together and are saved back as one claim.
 */
const claimServer = (): ConnectedServer | undefined => {
  // Editing a claim from another server edits that server's set, while it is still connected.
  if (claimServerUrl !== null) {
    const chosen = presenceServers().find((server) => server.url === claimServerUrl)
    if (chosen !== undefined) return chosen
  }
  return presenceLiveServer() ?? presenceServers()[0]
}

/** The server whose claims claim mode edits, when the drawer's Edit picked one. */
let claimServerUrl: string | null = null

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

/** One painter's claims, newest first. */
const claimsOf = (view: PresenceView, wplaceUserId: number): RegionClaim[] =>
  view.regions
    .filter((region) => region.claimant.wplaceUserId === wplaceUserId)
    .sort((left, right) => right.createdAt - left.createdAt)

/** "2 claims", or the one claim's shape and size. */
const claimsSummary = (claims: readonly RegionClaim[]): string | null => {
  const first = claims[0]
  if (first === undefined) return null
  return claims.length === 1 ? documentName(first.document) : `${claims.length} claims`
}

/**
 * Where a painter was last seen, for Fly to: their drafted pixels, else their viewport, else
 * their newest claim. Null when presence knows nothing about their location.
 */
export const painterLocation = (view: PresenceView, key: string): PresenceRect | null => {
  const peer = view.peers.find((held) => held.sessionId === key)
  if (peer !== undefined) {
    const seen = peer.draft?.rect ?? peer.viewport
    if (seen !== null) return seen
    return claimsOf(view, peer.painter.wplaceUserId)[0]?.rect ?? null
  }
  if (!key.startsWith('user:')) return null
  return claimsOf(view, Number(key.slice('user:'.length)))[0]?.rect ?? null
}

/** Ordered for finding people: you, then painting, browsing, online elsewhere, offline. */
const rank = (row: PainterRowModel): number => {
  if (row.mine) return 0
  if (!row.online) return 4
  if (row.activity.startsWith('painting')) return 1
  return row.activity === 'browsing' ? 2 : 3
}

/** Everyone presence knows about: live sessions first, then painters known only by a claim. */
const painterRows = (view: PresenceView): PainterRowModel[] => {
  const me = view.me
  const rows: PainterRowModel[] = []
  const seen = new Set<number>()
  const withClaims = (
    row: Omit<PainterRowModel, 'activity' | 'canFly'>,
    activity: string | null,
    located: boolean,
  ): PainterRowModel => {
    const claims = claimsOf(view, row.userId)
    const summary = claimsSummary(claims)
    const editable = row.mine ? claims[0] : undefined
    return {
      ...row,
      activity: activity ?? summary ?? (row.online ? 'online' : 'offline'),
      canFly: located || claims.length > 0,
      ...(editable === undefined ? {} : { editRegionId: editable.id }),
    }
  }
  if (me !== null) {
    seen.add(me.wplaceUserId)
    rows.push(
      withClaims(
        {
          key: `user:${me.wplaceUserId}`,
          name: me.displayName,
          userId: me.wplaceUserId,
          colour: presenceCss(me.wplaceUserId),
          mine: true,
          online: view.connected,
        },
        null,
        false,
      ),
    )
  }
  for (const peer of view.peers) {
    const id = peer.painter.wplaceUserId
    seen.add(id)
    const activity =
      peer.draft !== null
        ? `painting ${peer.draft.pixels.toLocaleString()} px`
        : peer.viewport !== null
          ? 'browsing'
          : null
    rows.push(
      withClaims(
        {
          key: peer.sessionId,
          name: peer.painter.displayName,
          userId: id,
          colour: presenceCss(id),
          mine: false,
          online: true,
        },
        activity,
        activity !== null,
      ),
    )
  }
  const claimants = new Map<number, RegionClaim>()
  for (const region of view.regions) {
    const id = region.claimant.wplaceUserId
    if (!seen.has(id) && !claimants.has(id)) claimants.set(id, region)
  }
  for (const [id, region] of claimants) {
    rows.push(
      withClaims(
        {
          key: `user:${id}`,
          name: region.claimant.displayName,
          userId: id,
          colour: presenceCss(id),
          mine: false,
          online: false,
        },
        null,
        false,
      ),
    )
  }
  return rows.sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name))
}

/** What the drawer shows: headcount, the painters, and whether the claim tool can open. */
export const presenceSummaryModel = (): PresenceSummaryModel | undefined => {
  const view = presenceView()
  if (!view.connected && view.regions.length === 0) return undefined
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
 * Take the map to a painter's latest known activity. Presence is read again here, not from the
 * rendered row, so someone who left between render and click gets a toast, not a stale flight.
 */
export const flyToPainter = (key: string): boolean => {
  const view = presenceView()
  const rect = painterLocation(view, key)
  if (rect === null) {
    toast('That painter’s location is no longer known.', 'error')
    return false
  }
  navigateTo({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, width: rect.w, height: rect.h })
  return true
}

const host = (): ClaimEditorHost => ({
  templateFor: (document) => targetFor(regionDocumentBounds(document))?.template.name ?? null,
  myRegions: () => {
    const view = presenceView()
    const server = claimServer()
    return view.regions
      .filter(
        (region) =>
          region.claimant.wplaceUserId === view.me?.wplaceUserId &&
          server !== undefined &&
          serverFor(region)?.url === server.url,
      )
      .map((region) => ({ id: region.id, document: region.document }))
  },
  save: async (id, document) => {
    const me = accountIdentity()
    if (me === null) return 'Wplace identity unavailable. Sign in, then retry.'
    // Your regions live on the claim server. An overlapping template is only a hint, and only
    // when it lives on that same server.
    // An existing claim stays on its own server; it is never written elsewhere.
    const server = id === null ? claimServer() : (presenceRegionServer(id) ?? undefined)
    if (server === undefined)
      return id === null
        ? 'Presence is not connected to any server.'
        : 'The server holding that claim is not connected.'
    const target = targetFor(regionDocumentBounds(document))
    const hint =
      target !== null && target.server.url === server.url
        ? (target.template.serverTemplateId ?? null)
        : null
    const error = await claimRegion(server, id ?? uuidV7(), {
      templateId: hint,
      document,
      label: '',
      actor: me,
    })
    if (error === null) toast(`Saved your regions: ${documentName(document)}.`)
    return error
  },
  remove: async (id) => {
    const me = accountIdentity()
    if (me === null) return 'Wplace identity unavailable. Sign in, then retry.'
    const region = presenceView().regions.find((held) => held.id === id)
    if (region === undefined) return 'That claim is gone already.'
    const server = serverFor(region)
    if (server === undefined) return 'That claim belongs to a server that is no longer connected.'
    return releaseRegion(server, id, me)
  },
  changed: () => rerenderPanel?.(),
})

/** Wire the editor to this module once, before anything can open it. */
export const installClaimToolHost = (): void => {
  installClaimEditor(host())
}

const ready = (): boolean => {
  const view = presenceView()
  const server = claimServer()
  const token = server === undefined ? null : activeServerToken(server)
  if (view.connected && view.me !== null && token !== null) return true
  message =
    view.me === null
      ? 'Sign in to Wplace to claim regions.'
      : !view.connected || server === undefined
        ? 'Connect to a server that supports painter presence to claim regions.'
        : `Add your access token for ${server.info?.name ?? server.url} to claim regions.`
  toast(message, 'error')
  rerenderPanel?.()
  return false
}

/** Enter claim mode with a tool in hand, from the rail, the drawer, or the M key. */
export const openClaimTool = (tool?: ClaimTool, rerender?: () => void): boolean => {
  if (rerender !== undefined) rerenderPanel = rerender
  if (!ready()) return false
  claimServerUrl = null
  message = undefined
  installClaimEditor(host())
  startClaimMode(tool)
  return true
}

/** Enter claim mode from the drawer's Edit, on the server that holds the chosen claim. */
export const openClaimEditor = (id: string, rerender?: () => void): boolean => {
  if (rerender !== undefined) rerenderPanel = rerender
  const region = presenceView().regions.find((held) => held.id === id)
  const server = region === undefined ? undefined : serverFor(region)
  if (server === undefined) {
    message = 'The server holding that claim is not connected.'
    toast(message, 'error')
    rerenderPanel?.()
    return false
  }
  // The claim's server is the one whose readiness and token matter, so it is chosen first.
  claimServerUrl = server.url
  if (!ready()) {
    claimServerUrl = null
    return false
  }
  message = undefined
  installClaimEditor(host())
  startClaimMode('select')
  return true
}
