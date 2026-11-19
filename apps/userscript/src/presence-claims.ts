import {
  type AdjacencyBudget,
  claimDocumentPixels,
  MAX_REGION_DOCUMENT_PIXELS,
  padRect,
  pixelsTouch,
  type RegionClaim,
  type RegionShapePixels,
  rectsIntersect,
  sameTemplateSurface,
  unionRect,
} from '@caelestis/shared'
import type { State } from './settings.js'

export interface DisplayClaim {
  readonly id: string
  readonly regions: readonly [RegionClaim, ...RegionClaim[]]
  readonly pixels: RegionShapePixels
}

// This bounds added grouping work across a whole snapshot, not just one mask allocation.
const MAX_GROUPING_WORK = MAX_REGION_DOCUMENT_PIXELS

/** Union already-composited claims so one document's subtractors cannot erase another's pixels. */
const unionPixels = (a: RegionShapePixels, b: RegionShapePixels): RegionShapePixels => {
  const rect = unionRect(a.rect, b.rect)
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
 * unions and exhausted aggregate work budgets retain separate masks rather than hiding claims.
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
    const budget: AdjacencyBudget = { remaining: MAX_GROUPING_WORK }
    for (const region of visible) {
      const pixels = claimDocumentPixels(region.document)
      if (pixels === null || pixels.count === 0) continue
      let group: DisplayClaim = { id: region.id, regions: [region], pixels }
      // Restart after a join: a bridge can connect groups considered earlier in the pass.
      for (let index = 0; index < groups.length; index++) {
        if (--budget.remaining < 0) break
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
        if (!rectsIntersect(padRect(a, 1), b)) continue
        const bounds = unionRect(a, b)
        if (bounds.w * bounds.h > MAX_REGION_DOCUMENT_PIXELS) continue
        if (!pixelsTouch(group.pixels, candidate.pixels, budget)) continue
        const memberCount = candidate.regions.length + group.regions.length
        const unionWork =
          bounds.w * bounds.h +
          a.w * a.h +
          b.w * b.h +
          memberCount * (1 + Math.ceil(Math.log2(memberCount))) +
          groups.length
        if (unionWork > budget.remaining) {
          budget.remaining = 0
          break
        }
        budget.remaining -= unionWork
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

/** Whether claims belong on screen: shown at all, and, if asked, only while the paint drawer is open. */
export const claimsVisible = (
  flags: Pick<State, 'showPresence' | 'showPresenceClaims' | 'showPresenceClaimsOnlyWhilePainting'>,
  paintOpen: boolean,
): boolean =>
  flags.showPresence &&
  flags.showPresenceClaims &&
  (!flags.showPresenceClaimsOnlyWhilePainting || paintOpen)

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

/** What the last displayed claims' masks hold in memory, for the profile. */
export const presenceMaskMemoryBytes = (): number =>
  retained.reduce((bytes, claim) => bytes + claim.pixels.mask.byteLength, 0)
