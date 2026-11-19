import {
  encodePresenceDraft,
  PRESENCE_DRAFT_MIN_MS,
  type PresenceDraft,
  TILE_SIZE,
  type TileCoord,
} from '@caelestis/shared'
import type { TileFrame } from './coordinates.js'
import { viewportRectIn } from './map-pointer.js'
import { presenceServers, setPresenceDraft, setPresenceViewport } from './presence-client.js'
import { measureProfileDetail, recordProfileWorkload } from './profile.js'
import { draftedPixelOffsets, draftedTiles } from './tile-transform.js'

/**
 * What this tab publishes about itself: the canvas rect its map shows and the pixels drafted in
 * Wplace's paint mode, read from the tile frames Wplace draws.
 */

/** Drafts past this many pixels publish their rect and count only; scanning stops here. */
const MAX_PUBLISHED_DRAFT_PIXELS = 4_096

/**
 * The drafted pixels across every tile that holds any, as one bounded presence draft.
 *
 * `offsetsOf` yields tile-local `y * TILE_SIZE + x` offsets, the shape the draft capture keeps.
 */
export const draftIn = (
  tiles: readonly TileCoord[],
  offsetsOf: (tile: TileCoord) => Iterable<number>,
): PresenceDraft | null => {
  // The mask stops at the cap, but the bounds and the count cover every drafted pixel: a peer
  // must see the whole draft's extent even when it only gets a rect.
  const pixels: { x: number; y: number }[] = []
  let count = 0
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const tile of tiles) {
    const baseX = tile.x * TILE_SIZE
    const baseY = tile.y * TILE_SIZE
    for (const offset of offsetsOf(tile)) {
      const x = baseX + (offset % TILE_SIZE)
      const y = baseY + Math.floor(offset / TILE_SIZE)
      count++
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
      if (pixels.length < MAX_PUBLISHED_DRAFT_PIXELS) pixels.push({ x, y })
    }
  }
  if (count <= MAX_PUBLISHED_DRAFT_PIXELS) return encodePresenceDraft(pixels)
  return { rect: { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }, pixels: count }
}

let draftCheckedAt = Number.NEGATIVE_INFINITY
let trailingDraftCheck: ReturnType<typeof setTimeout> | null = null

const scanDraft = (at: number): void => {
  draftCheckedAt = at
  const tiles = draftedTiles()
  const draft =
    tiles.length === 0
      ? null
      : measureProfileDetail('Presence draft scan', () => draftIn(tiles, draftedPixelOffsets))
  recordProfileWorkload('Presence local draft tiles', tiles.length)
  recordProfileWorkload('Presence local draft pixels', draft?.pixels ?? 0)
  setPresenceDraft(draft)
}

/**
 * Finish a draft scan that a frame skipped, once the rate limit allows it.
 *
 * Frames alone cannot be trusted to come back. The last frames of a paint session are the burst
 * after Wplace removes its draft layers, and once the map stops rendering while idle nothing follows
 * them. A draft cleared inside the one-second limit would otherwise stay on other painters' screens
 * until this tab's map next moved.
 */
const scheduleTrailingDraftCheck = (at: number): void => {
  if (trailingDraftCheck !== null) return
  trailingDraftCheck = setTimeout(
    () => {
      trailingDraftCheck = null
      if (presenceServers().length > 0) scanDraft(Date.now())
    },
    Math.max(0, draftCheckedAt + PRESENCE_DRAFT_MIN_MS - at),
  )
}

/** Feed one tile frame. Cheap on every frame; the draft scan runs at most once a second. */
export const observePresenceFrame = (frame: TileFrame): void => {
  if (presenceServers().length === 0) return
  setPresenceViewport(viewportRectIn(frame))
  const at = Date.now()
  if (at - draftCheckedAt >= PRESENCE_DRAFT_MIN_MS) scanDraft(at)
  else scheduleTrailingDraftCheck(at)
}
