import {
  claimDocumentPixels,
  claimDocuments,
  type PresenceRect,
  type RegionClaim,
  type RegionDocument,
  rectCentreDistance,
  rectIntersection,
  regionDocumentBounds,
  sameTemplateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type { ClaimTool } from '@caelestis/ui/elements'
import { currentSurface } from './alliance-surface.js'
import {
  type ClaimEditorHost,
  claimEditorTool,
  installClaimEditor,
  isClaimModeActive,
  onClaimEditorChange,
  startClaimMode,
  stopClaimMode,
  syncClaimEditorFrame,
} from './claim-editor.js'
import { claimRouter, installClaimRouting } from './claim-routing.js'
import { claimServers } from './claim-store.js'
import { registerDebugEntry } from './console-api.js'
import { onMapFrame, requestMapFrame } from './map-view.js'
import { presenceView } from './presence-client.js'
import { installQuickClaims, onQuickClaimPreviewChange } from './quick-claims.js'
import { activeServerToken } from './server-connections.js'
import { localTemplates, type PlacedTemplate } from './templates/catalog.js'
import { showToast } from './ui/notification-host.js'

/**
 * Region claims as one feature: whether claiming is possible right now, the claim editor's host,
 * and everything claims register on the page, installed once.
 */

/** Whether the claim tool can open, and if not, what the painter has to do first. */
export type ClaimAvailability =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string }

const unavailable = (reason: string): ClaimAvailability => ({ ready: false, reason })

/**
 * The one gate for claiming: a Wplace sign-in, a presence connection, servers that agree on the
 * season, an access token, and the world canvas, since alliance artboards have no presence room.
 */
export const claimAvailability = (): ClaimAvailability => {
  const view = presenceView()
  if (currentSurface().kind !== 'world')
    return unavailable('Claims live on the world canvas. Leave the alliance artboard to claim.')
  if (view.me === null) return unavailable('Sign in to Wplace to claim regions.')
  const servers = claimServers()
  const signedIn = servers.filter((server) => activeServerToken(server) !== null)
  const server = signedIn[0] ?? servers[0]
  if (!view.connected || server === undefined)
    return unavailable('Connect to a server that supports painter presence to claim regions.')
  if (new Set(signedIn.map((held) => held.season)).size !== 1)
    return unavailable('Connect servers for the same season, then retry.')
  if (activeServerToken(server) === null)
    return unavailable(
      `Add your access token for ${server.info?.name ?? server.url} to claim regions.`,
    )
  return { ready: true }
}

/** A claim on the world surface for a season a connected server holds: one the map can show. */
export const isShownClaim = (region: RegionClaim): boolean =>
  sameTemplateSurface(region.surface, WORLD_TEMPLATE_SURFACE) &&
  claimServers().some((server) => server.season === region.season)

/** "rectangle" for one shape, "3 shapes" for several. */
export const shapesName = (document: RegionDocument): string =>
  document.items.length === 1
    ? (document.items[0]?.shape.kind ?? 'shape')
    : `${document.items.length} shapes`

/** A document's shapes and pixel count, for the toast after a save. */
const documentName = (document: RegionDocument): string => {
  const pixels = claimDocuments(document).reduce(
    (total, part) => total + (claimDocumentPixels(part)?.count ?? 0),
    0,
  )
  return `${shapesName(document)} · ${pixels.toLocaleString()} px`
}

const templateRect = (template: PlacedTemplate): PresenceRect => ({
  x: template.originX,
  y: template.originY,
  w: template.width,
  h: template.height,
})

/** The server template overlapping `rect` whose overlap is centred nearest to it. */
const templateNear = (rect: PresenceRect | null): PlacedTemplate | null => {
  if (rect === null) return null
  let best: PlacedTemplate | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const template of localTemplates()) {
    if (
      template.origin !== 'server' ||
      !sameTemplateSurface(template.surface, WORLD_TEMPLATE_SURFACE)
    )
      continue
    const overlap = rectIntersection(rect, templateRect(template))
    if (overlap === null) continue
    const distance = rectCentreDistance(overlap, rect)
    if (distance < bestDistance) {
      bestDistance = distance
      best = template
    }
  }
  return best
}

const editorHost: ClaimEditorHost = {
  templateFor: (document) => templateNear(regionDocumentBounds(document))?.name ?? null,
  myRegions: () =>
    claimRouter
      .mine()
      .filter(isShownClaim)
      .map((region) => ({ id: region.id, document: region.document })),
  save: async (ids, documents) => {
    const result = await claimRouter.saveAll(ids, documents)
    if (result.error === null && documents.length > 0)
      showToast(
        `Saved your regions: ${documentName({ items: documents.flatMap((document) => document.items) })}.`,
      )
    return result
  },
}

/**
 * Enter claim mode with a tool in hand, from the rail, the drawer, or the M key; when claiming is
 * not possible, say why.
 */
export const openClaimTool = (tool?: ClaimTool): boolean => {
  const availability = claimAvailability()
  if (!availability.ready) {
    showToast(availability.reason, 'error')
    return false
  }
  startClaimMode(tool)
  return true
}

/** Install region claims once: routing, the editor, quick claims, and their redraws. */
export const installClaims = (): void => {
  installClaimRouting()
  installClaimEditor(editorHost)
  installQuickClaims()
  onClaimEditorChange(requestMapFrame)
  onQuickClaimPreviewChange(requestMapFrame)
  onMapFrame(syncClaimEditorFrame, 'Claim editor overlay')
  /** Claim mode, openable here without a presence server for pointer testing. */
  registerDebugEntry('claimTool', {
    active: () => isClaimModeActive(),
    tool: () => claimEditorTool(),
    start: (tool?: ClaimTool) => startClaimMode(tool),
    stop: () => stopClaimMode(),
  })
}
