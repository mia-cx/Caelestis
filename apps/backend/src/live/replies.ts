import {
  type LiveMutationError,
  type LiveSyncServerEvent,
  type LiveTileOffer,
  type LiveTileOfferBatch,
  type LiveTileOfferResponse,
  parseTileKey,
  satisfiesScope,
  type TileCoord,
} from '@caelestis/shared'
import type { LiveSubscriberAttachment } from './session.js'

type PaintOutcome = 'recorded' | 'partial' | 'duplicate'

/** A refused paint answers `duplicate` with its reason, so the client stops resending it. */
export const paintResult = (
  requestId: string,
  eventId: string,
  outcome: PaintOutcome | LiveMutationError,
): LiveSyncServerEvent =>
  outcome === 'recorded' || outcome === 'partial' || outcome === 'duplicate'
    ? { type: 'paint-result', requestId, eventId, result: outcome }
    : { type: 'paint-result', requestId, eventId, result: 'duplicate', error: outcome }

const NOTHING_OFFERED: LiveTileOfferResponse = {
  acknowledgedDeliveryIds: [],
  wanted: [],
  rejectedDeliveryIds: [],
}

export const tileOfferResult = (
  requestId: string,
  outcome: LiveTileOfferResponse | LiveMutationError,
): LiveSyncServerEvent =>
  typeof outcome === 'string'
    ? { type: 'tile-offer-result', requestId, response: NOTHING_OFFERED, error: outcome }
    : { type: 'tile-offer-result', requestId, response: outcome }

export const tileUploadResult = (
  requestId: string,
  deliveryId: string,
  error?: LiveMutationError,
): LiveSyncServerEvent =>
  error === undefined
    ? { type: 'tile-upload-result', requestId, deliveryId, accepted: true }
    : { type: 'tile-upload-result', requestId, deliveryId, accepted: false, error }

/** Whether this socket's credential may report for `season`. */
export const mayReport = (
  attachment: LiveSubscriberAttachment | null,
  season: number,
): attachment is LiveSubscriberAttachment =>
  attachment !== null &&
  attachment.season === season &&
  attachment.credentialScope !== undefined &&
  satisfiesScope(attachment.credentialScope, 'report')

/** Each offer with its tile, or null when a delivery or tile repeats or a tile key is invalid. */
export const parseOfferBatch = (
  batch: LiveTileOfferBatch,
): readonly { readonly offer: LiveTileOffer; readonly tile: TileCoord }[] | null => {
  const deliveries = new Set(batch.offers.map((offer) => offer.deliveryId))
  const tiles = new Set(batch.offers.map((offer) => offer.tile))
  if (deliveries.size !== batch.offers.length || tiles.size !== batch.offers.length) return null
  const parsed = []
  for (const offer of batch.offers) {
    const tile = parseTileKey(offer.tile)
    if (tile === null) return null
    parsed.push({ offer, tile })
  }
  return parsed
}
