import { type CaptureRun, decodeCaptureRun } from './capture-run.js'
import { isRecord, isSafeInteger } from './guards.js'
import {
  isPresenceDraft,
  isPresenceRect,
  isQuickClaimList,
  type PresencePeer,
  type PresenceServerEvent,
  type RegionClaim,
} from './presence.js'
import { isRegionDocument } from './region-shape.js'
import { templateSurface } from './template-surface.js'
import { isWorkIdentity } from './work.js'

/**
 * Reading presence traffic from a server, which is untrusted input. A valid event keeps its valid
 * parts: one malformed peer or claim is dropped rather than costing the whole snapshot.
 */

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_SESSION_ID = 64
const MAX_REGION_ID = 64
const MAX_TEMPLATE_ID = 128
const MAX_LABEL = 64

const isPresencePeer = (value: unknown): value is PresencePeer => {
  if (typeof value !== 'object' || value === null) return false
  const peer = value as PresencePeer
  return (
    typeof peer.sessionId === 'string' &&
    peer.sessionId.length > 0 &&
    peer.sessionId.length <= MAX_SESSION_ID &&
    (peer.publisherId === undefined || UUID_V7.test(peer.publisherId)) &&
    isWorkIdentity(peer.painter) &&
    (peer.viewport === null || isPresenceRect(peer.viewport)) &&
    (peer.draft === null || isPresenceDraft(peer.draft)) &&
    (peer.quickClaims === undefined || isQuickClaimList(peer.quickClaims))
  )
}

/** A claim from a server or a stored journal, checked before it reaches routing or rendering. */
export const isRegionClaim = (value: unknown): value is RegionClaim => {
  if (typeof value !== 'object' || value === null) return false
  const region = value as RegionClaim
  return (
    isSafeInteger(region.season) &&
    region.season >= 0 &&
    region.surface != null &&
    templateSurface(region.surface.kind, region.surface.allianceId) !== null &&
    (region.expiresAt === undefined || isSafeInteger(region.expiresAt)) &&
    typeof region.id === 'string' &&
    region.id.length <= MAX_REGION_ID &&
    (region.templateId === null ||
      (typeof region.templateId === 'string' && region.templateId.length <= MAX_TEMPLATE_ID)) &&
    isWorkIdentity(region.claimant) &&
    isRegionDocument(region.document) &&
    isPresenceRect(region.rect) &&
    typeof region.label === 'string' &&
    region.label.length <= MAX_LABEL &&
    isSafeInteger(region.createdAt)
  )
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []

/**
 * A server event from parsed JSON. Null when a known event is malformed; `'unknown'` for a type
 * this client does not know, which belongs to a newer server and is no reason to drop the socket.
 */
export const decodePresenceServerEvent = (
  value: unknown,
): PresenceServerEvent | 'unknown' | null => {
  if (typeof value !== 'object' || value === null) return null
  const event = value as Record<string, unknown>
  switch (event.type) {
    case 'presence-ready':
      if (
        typeof event.sessionId !== 'string' ||
        !isSafeInteger(event.online) ||
        !Array.isArray(event.peers) ||
        !Array.isArray(event.regions)
      )
        return null
      return {
        type: 'presence-ready',
        sessionId: event.sessionId,
        online: event.online,
        peers: event.peers.filter(isPresencePeer),
        regions: event.regions.filter(isRegionClaim),
        ownedRegionIds: strings(event.ownedRegionIds),
        canWrite: event.canWrite === true,
      }
    case 'presence-delta':
      if (
        !isSafeInteger(event.online) ||
        !Array.isArray(event.upsert) ||
        !Array.isArray(event.remove)
      )
        return null
      return {
        type: 'presence-delta',
        online: event.online,
        upsert: event.upsert.filter(isPresencePeer),
        remove: strings(event.remove),
      }
    case 'regions':
      if (!Array.isArray(event.regions)) return null
      return {
        type: 'regions',
        regions: event.regions.filter(isRegionClaim),
        ownedRegionIds: strings(event.ownedRegionIds),
      }
    case 'claims-renewed':
      if (!isSafeInteger(event.expiresAt)) return null
      return { type: 'claims-renewed', expiresAt: event.expiresAt, ids: strings(event.ids) }
    case 'capture-runs': {
      if (!Array.isArray(event.runs)) return null
      const runs = event.runs.map(decodeCaptureRun)
      return runs.every((run): run is CaptureRun => run !== null)
        ? { type: 'capture-runs', runs }
        : null
    }
    case 'clock':
      if (!isSafeInteger(event.sent) || !isSafeInteger(event.at)) return null
      return { type: 'clock', sent: event.sent, at: event.at }
    default:
      return 'unknown'
  }
}

/** A server's claims as its HTTP snapshot, `GET /work/regions`, reports them. */
export interface RegionSnapshot {
  readonly regions: readonly RegionClaim[]
  readonly ownedRegionIds: readonly string[]
  readonly canWrite: boolean
}

/** A region snapshot from parsed JSON. Null when malformed; malformed claims are dropped. */
export const decodeRegionSnapshot = (value: unknown): RegionSnapshot | null => {
  if (!isRecord(value) || !Array.isArray(value.regions)) return null
  return {
    regions: value.regions.filter(isRegionClaim),
    ownedRegionIds: strings(value.ownedRegionIds),
    canWrite: value.canWrite === true,
  }
}
