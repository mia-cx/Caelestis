import { TILE_SIZE } from '@caelestis/shared'
import { DEFAULT_MARKER_BUDGET } from '../marker-budget.js'
import { MARK_BLOCK_SIZE, MARK_BLOCKS_PER_ROW, type MarkList } from '../templates/mark-list.js'

/** Default approximate point target for one marker kind across the viewport. */
export const MARKER_VIEWPORT_BUDGET = DEFAULT_MARKER_BUDGET

/**
 * Fraction of visible marker points to draw.
 *
 * Each pixel's mark is kept when its coordinate hash falls below this share, so the same pixels
 * stay drawn as other marks are patched, and a higher rate only adds to a lower one's. Lists are
 * ordered so the kept marks of each on-screen block are one run, and the renderer submits only
 * those runs. This is an approximate budget by design: avoiding an exact CPU selection means
 * changing the limit is O(1), creates no typed arrays, and leaves the lists' GPU copies untouched.
 */
export const markerSampleRate = (sourcePoints: number, budget = MARKER_VIEWPORT_BUDGET): number => {
  const source = Math.max(0, Math.floor(sourcePoints))
  const limit = Math.max(0, Math.floor(budget))
  if (source === 0 || limit === 0) return 0
  return Math.min(1, limit / source)
}

interface MarkerViewport {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The source pixels `[startX, endX) × [startY, endY)` a placed tile shows on screen. */
export interface SourceRect {
  readonly startX: number
  readonly endX: number
  readonly startY: number
  readonly endY: number
  /** The whole source is on screen. */
  readonly whole: boolean
}

/** Which source pixels of a tile drawn at `tile` land inside the drawing buffer, or null for none. */
export const visibleSourceRect = (
  tile: MarkerViewport,
  bufferWidth: number,
  bufferHeight: number,
  sourceWidth = TILE_SIZE,
  sourceHeight = TILE_SIZE,
): SourceRect | null => {
  if (bufferWidth <= 0 || bufferHeight <= 0) return null
  if (tile.width <= 0 || tile.height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return null
  if (
    tile.x >= bufferWidth ||
    tile.y >= bufferHeight ||
    tile.x + tile.width <= 0 ||
    tile.y + tile.height <= 0
  )
    return null
  if (
    tile.x >= 0 &&
    tile.y >= 0 &&
    tile.x + tile.width <= bufferWidth &&
    tile.y + tile.height <= bufferHeight
  )
    return { startX: 0, endX: sourceWidth, startY: 0, endY: sourceHeight, whole: true }
  const clampPixel = (value: number, size: number): number => Math.max(0, Math.min(size, value))
  const startX = clampPixel(Math.ceil((-tile.x * sourceWidth) / tile.width - 0.5), sourceWidth)
  const endX = clampPixel(
    Math.ceil(((bufferWidth - tile.x) * sourceWidth) / tile.width - 0.5),
    sourceWidth,
  )
  const startY = clampPixel(Math.ceil((-tile.y * sourceHeight) / tile.height - 0.5), sourceHeight)
  const endY = clampPixel(
    Math.ceil(((bufferHeight - tile.y) * sourceHeight) / tile.height - 0.5),
    sourceHeight,
  )
  if (startX >= endX || startY >= endY) return null
  return { startX, endX, startY, endY, whole: false }
}

/** Visit every mark-list block that overlaps a source rectangle, row by row. */
export const forEachVisibleBlock = (rect: SourceRect, visit: (block: number) => void): void =>
  forEachVisibleBlockRow(rect, (first, last) => {
    for (let block = first; block <= last; block++) visit(block)
  })

/** Visit each row of blocks that overlaps a source rectangle, as its first and last block. */
export const forEachVisibleBlockRow = (
  rect: SourceRect,
  visit: (first: number, last: number) => void,
): void => {
  const firstX = Math.floor(rect.startX / MARK_BLOCK_SIZE)
  const lastX = Math.ceil(rect.endX / MARK_BLOCK_SIZE) - 1
  const lastY = Math.ceil(rect.endY / MARK_BLOCK_SIZE)
  for (let y = Math.floor(rect.startY / MARK_BLOCK_SIZE); y < lastY; y++)
    visit(y * MARK_BLOCKS_PER_ROW + firstX, y * MARK_BLOCKS_PER_ROW + lastX)
}

/**
 * About how many of a list's live marks are on screen, counted by block.
 *
 * Blocks overlapping the screen count whole, and marks painted since the scan count as visible.
 * Both include removed marks, so the count is scaled to the list's live share, rounded up so a
 * visible live mark never scales away to nothing.
 */
export const visibleListPoints = (list: MarkList, rect: SourceRect | null): number => {
  if (rect === null || list.live === 0) return 0
  const starts = list.blockStarts()
  let slots = list.length - list.sorted
  if (rect.whole) slots += list.sorted
  else
    forEachVisibleBlock(rect, (block) => {
      slots += (starts[block + 1] as number) - (starts[block] as number)
    })
  return Math.ceil((slots * list.live) / list.length)
}

export interface MarkerVisibilityBudget {
  remainingComparisons: number
}

/** Shared per-frame ceiling for every clipped marker count. */
export const markerVisibilityBudget = (): MarkerVisibilityBudget => ({
  remainingComparisons: 64_000,
})

/**
 * Count visible packed marker coordinates without source-sized work or allocations.
 *
 * Mismatch marks are ordered by tile-local y then x. A clipped rectangle is therefore a pair of
 * binary searches per visible row. Fully visible and fully clipped regions return without
 * searching. A shared frame allowance falls back to the conservative full source count before
 * aggregate search work can become a stall.
 */
export const visibleMarkerPoints = (
  marks: Uint32Array,
  tile: MarkerViewport,
  bufferWidth: number,
  bufferHeight: number,
  budget: MarkerVisibilityBudget,
  sourceWidth = TILE_SIZE,
  sourceHeight = TILE_SIZE,
): number => {
  if (marks.length === 0) return 0
  const rect = visibleSourceRect(tile, bufferWidth, bufferHeight, sourceWidth, sourceHeight)
  if (rect === null) return 0
  if (rect.whole) return marks.length
  const { startX, endX, startY, endY } = rect

  const comparisonsPerSearch = Math.ceil(Math.log2(marks.length + 1))
  const requiredComparisons = (endY - startY) * 2 * comparisonsPerSearch
  // Counting the whole source is conservative: the shader may retain fewer visible points, but it
  // cannot exceed the configured target because uncounted offscreen points remain in the divisor.
  if (requiredComparisons > budget.remainingComparisons) return marks.length
  budget.remainingComparisons -= requiredComparisons

  const lowerBound = (coordinate: number): number => {
    let low = 0
    let high = marks.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (((marks[middle] as number) & 0x0f_ffff) < coordinate) low = middle + 1
      else high = middle
    }
    return low
  }
  let visible = 0
  for (let y = startY; y < endY; y++) {
    visible += lowerBound((y << 10) | endX) - lowerBound((y << 10) | startX)
  }
  return visible
}

/** GPU sampling retains no density-analysis or sampled-marker CPU buffers. */
export const markerDensityMemoryBytes = (): number => 0
