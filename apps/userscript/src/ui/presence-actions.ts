import type { PresencePeer, PresenceRect, RegionClaim } from '@caelestis/shared'
import type { ClaimRowModel, PainterRowModel, PresenceSummaryModel } from '@caelestis/ui/elements'
import { isClaimModeActive } from '../claim-editor.js'
import { claimRouter } from '../claim-routing.js'
import { claimAvailability, isShownClaim, shapesName } from '../claims.js'
import {
  type PresenceView,
  presenceCanWriteClaims,
  presenceServerClaims,
  presenceServers,
  presenceView,
} from '../presence-client.js'
import { presenceCss } from '../presence-colour.js'
import { navigateTo } from '../templates/navigate.js'
import { showToast } from './notification-host.js'

/**
 * The Painters drawer: everyone presence knows about, with a Fly to that goes to where they were
 * last seen, and every region claim, with a Fly to that frames it and a Clear for your own.
 */

const clearing = new Set<string>()

/**
 * Where a painter is right now, for Fly to: their drafted pixels, else their viewport. Null when
 * they have left or have not shared a viewport.
 */
const painterLocation = (view: PresenceView, sessionId: string): PresenceRect | null => {
  const peer = view.peers.find((held) => held.sessionId === sessionId)
  return peer === undefined ? null : (peer.draft?.rect ?? peer.viewport)
}

/** Painting first, then browsing, then those who have not shared a viewport. */
const rank = (peer: PresencePeer): number =>
  peer.draft !== null ? 0 : peer.viewport !== null ? 1 : 2

/** The unique nearby sessions received across all connected servers, ordered for the drawer. */
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

/** List server-confirmed claims; the local retry journal is not evidence of an active claim. */
const knownClaims = (view: PresenceView): { mine: RegionClaim[]; others: RegionClaim[] } => {
  const me = view.me?.wplaceUserId
  const mine = view.regions
    .filter((region) => isShownClaim(region) && region.claimant.wplaceUserId === me)
    .sort((left, right) => right.createdAt - left.createdAt)
  const others = view.regions
    .filter((region) => isShownClaim(region) && region.claimant.wplaceUserId !== me)
    .sort(
      (left, right) =>
        left.claimant.displayName.localeCompare(right.claimant.displayName) ||
        right.createdAt - left.createdAt,
    )
  return { mine, others }
}

/**
 * A row's description from the shape kinds and the server's bounding rect alone. Rows are built
 * for every claim on every panel render, and the snapshot replaces its documents each refresh, so
 * nothing here may rasterise.
 */
const claimSummary = (region: RegionClaim): string =>
  `${shapesName(region.document)} · ${region.rect.w}×${region.rect.h}`

const clearableClaimIds = (view: PresenceView): Set<string> =>
  new Set(
    presenceServers()
      .filter(presenceCanWriteClaims)
      .flatMap((server) => presenceServerClaims(server).regions)
      .filter((region) => region.claimant.wplaceUserId === view.me?.wplaceUserId)
      .map((region) => region.id),
  )

const claimRows = (view: PresenceView): ClaimRowModel[] => {
  const { mine, others } = knownClaims(view)
  const clearable = clearableClaimIds(view)
  const row = (region: RegionClaim, isMine: boolean): ClaimRowModel => ({
    key: region.id,
    name: isMine ? 'You' : region.claimant.displayName,
    userId: region.claimant.wplaceUserId,
    colour: presenceCss(region.claimant.wplaceUserId),
    description: claimSummary(region),
    mine: isMine,
    canClear: clearable.has(region.id),
    clearing: clearing.has(region.id),
  })
  return [...mine.map((region) => row(region, true)), ...others.map((region) => row(region, false))]
}

/** Persist explicit deletion and retry failed replicas without requiring the creating credential. */
export const clearClaim = async (id: string, changed: () => void): Promise<void> => {
  if (clearing.has(id) || !clearableClaimIds(presenceView()).has(id)) return
  clearing.add(id)
  changed()
  try {
    const error = await claimRouter().remove(id)
    if (error !== null) showToast(error, 'error')
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not clear the claim. Retry.', 'error')
  } finally {
    clearing.delete(id)
    changed()
  }
}

/** What the drawer shows: headcount, the painters, and whether the claim tool can open. */
export const presenceSummaryModel = (): PresenceSummaryModel | undefined => {
  const view = presenceView()
  // Without the socket there is nobody to list and nothing to claim, so the drawer stays away.
  if (!view.connected) return undefined
  const availability = claimAvailability()
  return {
    online: view.online,
    connected: view.connected,
    players: painterRows(view),
    claims: claimRows(view),
    canClaim: availability.ready && !isClaimModeActive(),
    ...(availability.ready ? {} : { message: availability.reason }),
  }
}

const flyToRect = (rect: PresenceRect): void =>
  navigateTo({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, width: rect.w, height: rect.h })

/**
 * Take the map to where a painter is. Presence is read again here, not from the rendered row,
 * so someone who left between render and click gets a toast, not a stale flight.
 */
export const flyToPainter = (sessionId: string): boolean => {
  const rect = painterLocation(presenceView(), sessionId)
  if (rect === null) {
    showToast('That painter is no longer here.', 'error')
    return false
  }
  flyToRect(rect)
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
    showToast('That claim is no longer here.', 'error')
    return false
  }
  flyToRect(region.rect)
  return true
}
