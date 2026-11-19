import {
  BLANK,
  PALETTE_SIZE,
  parseTileKey,
  TILE_SIZE,
  type TileCoord,
  WRONG,
} from '@caelestis/shared'
import { count } from '../debug.js'
import { comparisonDraftPixels } from '../draft-pixels.js'
import { UNPAINTED } from '../native-pixels.js'
import { loadTilePixels, tilePixels } from '../tile-pixels.js'
import { worldTemplates } from './capture-scope.js'
import { isTemplateVisible, type PlacedTemplate, templateTileKeys } from './catalog.js'
import { classifyPixel } from './pixel-tally.js'
import { horizontalSpans, wrappedDeltaX } from './placement.js'
import type {
  ColourNavigationExclusion,
  ColourNavigationTarget,
  ColourTargetKind,
} from './progress-types.js'
import { templateChunks } from './residency.js'
import { pixelRect, type SparsePixels } from './sparse-pixels.js'

/** Finding the nearest pixel of one colour that still needs painting, or is painted wrong. */

interface NavigationCandidate {
  readonly template: PlacedTemplate
  readonly tile: TileCoord
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  readonly sourceStart: number
  readonly worldStart: number
  readonly minimumDistance: number
}

const distanceToInterval = (value: number, start: number, end: number): number =>
  value < start ? start - value : value >= end ? value - end : 0

/** Lower bound from a reference pixel to a possibly wrapped canvas rectangle. */
const minimumDistanceTo = (
  reference: { readonly x: number; readonly y: number },
  left: number,
  right: number,
  top: number,
  bottom: number,
): number => {
  const width = right - left
  const relativeCentre = wrappedDeltaX(reference.x, left + width / 2)
  const relativeLeft = relativeCentre - width / 2
  const dx = distanceToInterval(0, relativeLeft, relativeLeft + width)
  const dy = distanceToInterval(reference.y, top, bottom)
  return dx * dx + dy * dy
}

const navigationCandidates = (
  reference: {
    readonly x: number
    readonly y: number
  },
  templateId?: string,
): NavigationCandidate[] => {
  const candidates: NavigationCandidate[] = []
  for (const template of worldTemplates()) {
    if (!isTemplateVisible(template)) continue
    if (templateId !== undefined && template.id !== templateId) continue
    const templateTop = template.originY
    const templateBottom = template.originY + template.height
    for (const key of templateTileKeys(template)) {
      const tile = parseTileKey(key)
      if (tile === null) continue
      const tileLeft = tile.x * TILE_SIZE
      const tileTop = tile.y * TILE_SIZE
      const tileRight = tileLeft + TILE_SIZE
      const tileBottom = tileTop + TILE_SIZE
      const top = Math.max(templateTop, tileTop)
      const bottom = Math.min(templateBottom, tileBottom)
      if (bottom <= top) continue
      for (const span of horizontalSpans(template)) {
        const left = Math.max(span.worldStart, tileLeft)
        const right = Math.min(span.worldEnd, tileRight)
        if (right <= left) continue
        candidates.push({
          template,
          tile,
          left,
          right,
          top,
          bottom,
          sourceStart: span.sourceStart,
          worldStart: span.worldStart,
          minimumDistance: minimumDistanceTo(reference, left, right, top, bottom),
        })
      }
    }
  }
  candidates.sort((left, right) => left.minimumDistance - right.minimumDistance)
  return candidates
}

/** The template's pixels under a candidate rectangle, one row per canvas row it covers. */
const candidateWindow = (candidate: NavigationCandidate, wanted: SparsePixels): Uint8Array =>
  pixelRect(
    wanted,
    candidate.sourceStart + candidate.left - candidate.worldStart,
    candidate.top - candidate.template.originY,
    candidate.right - candidate.left,
    candidate.bottom - candidate.top,
  )

const candidateContainsColour = (
  candidate: NavigationCandidate,
  wanted: SparsePixels,
  index: number,
): boolean => candidateWindow(candidate, wanted).includes(index)

interface CandidateResult {
  readonly target: ColourNavigationTarget | null
  readonly distance: number
  readonly desiredPixels: number
  readonly matchingPixels: number
}

const scanCandidate = (
  candidate: NavigationCandidate,
  wantedPixels: SparsePixels,
  pixels: Uint8Array,
  index: number,
  kind: ColourTargetKind,
  reference: { readonly x: number; readonly y: number },
  previousDistance: number,
  exclude?: ColourNavigationExclusion,
): CandidateResult => {
  let target: ColourNavigationTarget | null = null
  let distance = previousDistance
  let desiredPixels = 0
  let matchingPixels = 0
  const draft = comparisonDraftPixels(candidate.tile)
  const tileLeft = candidate.tile.x * TILE_SIZE
  const tileTop = candidate.tile.y * TILE_SIZE
  const window = candidateWindow(candidate, wantedPixels)
  const sought = kind === 'unpainted' ? BLANK : WRONG
  let windowAt = 0
  for (let y = candidate.top; y < candidate.bottom; y++) {
    let tileAt = (y - tileTop) * TILE_SIZE + (candidate.left - tileLeft)
    for (let x = candidate.left; x < candidate.right; x++, tileAt++, windowAt++) {
      const wanted = window[windowAt]
      if (wanted !== index) continue
      desiredPixels++
      const drafted = draft?.[tileAt] ?? UNPAINTED
      const placed = drafted === UNPAINTED ? (pixels[tileAt] as number) : drafted
      if (classifyPixel(wanted, placed, UNPAINTED) !== sought) continue
      matchingPixels++
      if (
        exclude?.templateId === candidate.template.id &&
        exclude.kind === kind &&
        exclude.x === x &&
        exclude.y === y
      )
        continue
      const dx = wrappedDeltaX(reference.x, x + 0.5)
      const dy = y + 0.5 - reference.y
      const candidateDistance = dx * dx + dy * dy
      if (candidateDistance >= distance) continue
      distance = candidateDistance
      target = { templateId: candidate.template.id, x, y, kind }
    }
  }
  return { target, distance, desiredPixels, matchingPixels }
}

const recordNavigationScan = (rectangles: number, desiredPixels: number, matches: number): void => {
  count('paint:navigation loaded rectangles', rectangles)
  count('paint:navigation desired pixels checked', desiredPixels)
  count('paint:navigation targets found', matches)
}

/**
 * Exact nearest disagreement, chasing only the nearest relevant Wplace tiles not already retained.
 *
 * The server aggregate chooses blank work before mismatches. The browser owns navigation because it
 * already has the overlay's coordinates; on a cache miss this loads canvas tiles nearest-first and
 * stops as soon as every remaining tile is farther away than the best exact pixel found.
 */
export const nearestColourTarget = async (
  index: number,
  kind: ColourTargetKind,
  reference: { readonly x: number; readonly y: number },
  templateId?: string,
  exclude?: ColourNavigationExclusion,
): Promise<ColourNavigationTarget | null> => {
  if (!Number.isInteger(index) || index < 0 || index >= PALETTE_SIZE) return null
  const candidates = navigationCandidates(reference, templateId)
  let best: ColourNavigationTarget | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  let desiredPixels = 0
  let matchingPixels = 0
  let loaded = 0
  // Evicted templates load only when the search reaches them, nearest first.
  const wantedPixels = new Map<string, SparsePixels>()
  for (const candidate of candidates) {
    if (candidate.minimumDistance > bestDistance) break
    const { template } = candidate
    const wanted = wantedPixels.get(template.id) ?? (await templateChunks(template))
    wantedPixels.set(template.id, wanted)
    let pixels = tilePixels(candidate.tile)
    if (pixels === null) {
      if (!candidateContainsColour(candidate, wanted, index)) continue
      pixels = await loadTilePixels(candidate.tile)
    }
    if (pixels === null) continue
    loaded++
    const scanned = scanCandidate(
      candidate,
      wanted,
      pixels,
      index,
      kind,
      reference,
      bestDistance,
      exclude,
    )
    desiredPixels += scanned.desiredPixels
    matchingPixels += scanned.matchingPixels
    if (scanned.target !== null) best = scanned.target
    bestDistance = scanned.distance
  }
  recordNavigationScan(loaded, desiredPixels, matchingPixels)
  return best
}
