import { BLANK, MATCH, TILE_SIZE, TRANSPARENT_INDEX, WRONG } from '@caelestis/shared'

export interface ChunkRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface ColourClassification {
  readonly index: number
  readonly correct: number
  readonly wrong: number
  readonly blank: number
  readonly total: number
}

export interface ChunkClassification {
  readonly correct: number
  readonly wrong: number
  readonly blank: number
  /** Ascending palette index, one entry per colour the chunk wants. */
  readonly colours: readonly ColourClassification[]
  /** One MATCH/WRONG/BLANK byte per chunk pixel; transparent template pixels stay MATCH. */
  readonly classifications: Uint8Array
}

const CLASSES = 3
const INDEX_SPACE = 256

/**
 * Classify one template chunk against the canvas pixels under its rectangle.
 *
 * This is the hottest loop in tile ingestion: a full chunk is one million pixels. It runs on the
 * event loop, so it must not allocate or hash per pixel. Per-colour counts live in one typed array
 * indexed by palette index and class; the colour list is built once at the end.
 */
export const classifyChunk = (
  chunk: Uint8Array,
  canvas: Uint8Array,
  rect: ChunkRect,
): ChunkClassification => {
  const { left, top, width, height } = rect
  if (
    left < 0 ||
    top < 0 ||
    width <= 0 ||
    height <= 0 ||
    left + width > TILE_SIZE ||
    top + height > TILE_SIZE
  ) {
    throw new RangeError('chunk rectangle must fit one canvas tile')
  }
  if (chunk.length !== width * height || canvas.length !== TILE_SIZE * TILE_SIZE) {
    throw new RangeError('chunk and canvas must cover their rectangles')
  }
  const classifications = new Uint8Array(width * height)
  const counts = new Uint32Array(INDEX_SPACE * CLASSES)
  // Locals keep the inner loop free of module-binding reads under every module transform.
  const transparent = TRANSPARENT_INDEX
  const match = MATCH
  const wrongClass = WRONG
  const blankClass = BLANK
  const tileSize = TILE_SIZE
  for (let y = 0; y < height; y += 1) {
    const chunkRow = y * width
    const canvasRow = (top + y) * tileSize + left
    for (let x = 0; x < width; x += 1) {
      // Lengths were validated above, so every read below is in range.
      const wanted = chunk[chunkRow + x] as number
      if (wanted === transparent) continue
      const actual = canvas[canvasRow + x] as number
      const classification =
        actual === transparent ? blankClass : actual === wanted ? match : wrongClass
      classifications[chunkRow + x] = classification
      const slot = wanted * CLASSES + classification
      counts[slot] = (counts[slot] as number) + 1
    }
  }
  let correct = 0
  let wrong = 0
  let blank = 0
  const colours: ColourClassification[] = []
  for (let index = 0; index < INDEX_SPACE; index += 1) {
    const matched = counts[index * CLASSES + MATCH] ?? 0
    const mismatched = counts[index * CLASSES + WRONG] ?? 0
    const missing = counts[index * CLASSES + BLANK] ?? 0
    const total = matched + mismatched + missing
    if (total === 0) continue
    correct += matched
    wrong += mismatched
    blank += missing
    colours.push({ index, correct: matched, wrong: mismatched, blank: missing, total })
  }
  return { correct, wrong, blank, colours, classifications }
}
