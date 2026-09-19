import {
  MAX_REGION_DOCUMENT_PIXELS,
  type PresenceRect,
  type RegionClaim,
  type RegionShapePixels,
  rectIntersection,
  sameTemplateSurface,
} from '@caelestis/shared'
import { claimDocumentPixels } from './claim-document.js'
import { registerProfileMemorySource } from './profile.js'

export interface DisplayClaim {
  readonly id: string
  readonly regions: readonly [RegionClaim, ...RegionClaim[]]
  readonly pixels: RegionShapePixels
}

const unionBounds = (a: PresenceRect, b: PresenceRect): PresenceRect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
  h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y),
})

const pixelsTouch = (a: RegionShapePixels, b: RegionShapePixels): boolean => {
  const bounds = a.rect
  const overlap = rectIntersection(
    { x: bounds.x - 1, y: bounds.y - 1, w: bounds.w + 2, h: bounds.h + 2 },
    b.rect,
  )
  if (overlap === null) return false
  for (let y = overlap.y; y < overlap.y + overlap.h; y++) {
    for (let x = overlap.x; x < overlap.x + overlap.w; x++) {
      if (b.mask[(y - b.rect.y) * b.rect.w + x - b.rect.x] !== 1) continue
      for (
        let ny = Math.max(y - 1, bounds.y);
        ny <= Math.min(y + 1, bounds.y + bounds.h - 1);
        ny++
      ) {
        for (
          let nx = Math.max(x - 1, bounds.x);
          nx <= Math.min(x + 1, bounds.x + bounds.w - 1);
          nx++
        ) {
          if (a.mask[(ny - bounds.y) * bounds.w + nx - bounds.x] === 1) return true
        }
      }
    }
  }
  return false
}

/** Union already-composited claims so one document's subtractors cannot erase another's pixels. */
const unionPixels = (a: RegionShapePixels, b: RegionShapePixels): RegionShapePixels => {
  const rect = unionBounds(a.rect, b.rect)
  const mask = new Uint8Array(rect.w * rect.h)
  let count = 0
  for (const source of [a, b]) {
    for (let y = 0; y < source.rect.h; y++) {
      const row = (source.rect.y - rect.y + y) * rect.w + source.rect.x - rect.x
      for (let x = 0; x < source.rect.w; x++) {
        if (source.mask[y * source.rect.w + x] !== 1 || mask[row + x] === 1) continue
        mask[row + x] = 1
        count++
      }
    }
  }
  return { rect, mask, count }
}

/**
 * Cached display unions, shared by the overlay and hover labels. Saved identities stay intact.
 * Only actual pixel adjacency joins claims; empty bounds and subtraction gaps stay separate. Oversized
 * unions retain separate masks under the existing raster budget rather than hiding claims.
 */
export const createDisplayClaims = () => {
  let previous: readonly RegionClaim[] = []
  let displayed: readonly DisplayClaim[] = []
  return (
    regions: readonly RegionClaim[],
    editingIds: readonly string[] = [],
  ): readonly DisplayClaim[] => {
    const editing = new Set(editingIds)
    const visible = regions.filter((region) => !editing.has(region.id))
    if (
      visible.length === previous.length &&
      visible.every((region, index) => region === previous[index])
    )
      return displayed
    const groups: DisplayClaim[] = []
    for (const region of visible) {
      const pixels = claimDocumentPixels(region.document)
      if (pixels === null || pixels.count === 0) continue
      let group: DisplayClaim = { id: region.id, regions: [region], pixels }
      // Restart after a join: a bridge can connect groups considered earlier in the pass.
      for (let index = 0; index < groups.length; index++) {
        const candidate = groups[index] as DisplayClaim
        const other = candidate.regions[0]
        if (
          region.claimant.wplaceUserId !== other.claimant.wplaceUserId ||
          region.season !== other.season ||
          !sameTemplateSurface(region.surface, other.surface)
        )
          continue
        const a = group.pixels.rect
        const b = candidate.pixels.rect
        if (a.x > b.x + b.w || b.x > a.x + a.w || a.y > b.y + b.h || b.y > a.y + a.h) continue
        const bounds = unionBounds(a, b)
        if (bounds.w * bounds.h > MAX_REGION_DOCUMENT_PIXELS) continue
        if (!pixelsTouch(group.pixels, candidate.pixels)) continue
        const members: [RegionClaim, ...RegionClaim[]] = [...candidate.regions, ...group.regions]
        group = {
          id: members
            .map((member) => member.id)
            .sort()
            .join(','),
          regions: members,
          pixels: unionPixels(candidate.pixels, group.pixels),
        }
        groups.splice(index, 1)
        index = -1
      }
      groups.push(group)
    }
    previous = visible
    displayed = groups
    return displayed
  }
}

const readDisplayClaims = createDisplayClaims()
let retained: readonly DisplayClaim[] = []

/** The current claim masks for painting and hit testing, excluding claims open in the editor. */
export const displayClaims = (
  regions: readonly RegionClaim[],
  editingIds: readonly string[] = [],
): readonly DisplayClaim[] => {
  retained = readDisplayClaims(regions, editingIds)
  return retained
}

registerProfileMemorySource('Presence region masks', () =>
  retained.reduce((bytes, claim) => bytes + claim.pixels.mask.byteLength, 0),
)
