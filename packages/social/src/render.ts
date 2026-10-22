import {
  type ArchiveHistory,
  decodePng,
  type Template,
  TILE_SIZE,
  type TileHistoryResponse,
  timelapseCaptureRect,
  WORLD_PIXELS,
} from '@caelestis/shared'
import { mapAttributionStamp } from './attribution.js'
import { type ReadMapTile, renderBasemap } from './basemap.js'
import { encodeTimelapseGif, HISTORY_PLAYBACK_SECONDS } from './gif.js'
import { SOCIAL_IMAGE_HEIGHT, SOCIAL_IMAGE_WIDTH } from './image.js'
import { mergeArchiveFrames, type PlaybackFrame } from './playback.js'

const MAX_FPS = 30
const MAX_FRAMES = MAX_FPS * HISTORY_PLAYBACK_SECONDS
const MAX_SOURCE_IMAGES = 4096
const BACKGROUND = [27, 27, 32, 255]

/** Sample by recorded time so dense retained tiers cannot crowd out older history. */
export const sampleTimeline = (times: readonly number[], limit = MAX_FRAMES): number[] => {
  const sorted = [...new Set(times)].sort((a, b) => a - b)
  if (sorted.length <= limit) return sorted
  const first = sorted[0]
  const span = sorted[sorted.length - 1] - first
  let index = 0
  return [
    ...new Set(
      Array.from({ length: limit }, (_, i) => {
        const time = first + (i * span) / (limit - 1)
        while (index + 1 < sorted.length && sorted[index + 1] <= time) index++
        return sorted[index]
      }),
    ),
  ]
}

/** Map output pixels to native tile pixels, including longitude wrap. */
export const captureSamples = (
  bbox: Template['bbox'],
  width = SOCIAL_IMAGE_WIDTH,
  height = SOCIAL_IMAGE_HEIGHT,
) => {
  const rect = timelapseCaptureRect(bbox)
  const tiles = new Map<string, [number, number][]>()
  for (let y = 0; y < height; y++) {
    const worldY = Math.floor(rect.y + ((y + 0.5) * rect.height) / height)
    for (let x = 0; x < width; x++) {
      const rawX = Math.floor(rect.x + ((x + 0.5) * rect.width) / width)
      const worldX = ((rawX % WORLD_PIXELS) + WORLD_PIXELS) % WORLD_PIXELS
      const key = `${Math.floor(worldX / TILE_SIZE)}/${Math.floor(worldY / TILE_SIZE)}`
      const samples = tiles.get(key) ?? []
      samples.push([
        (y * width + x) * 4,
        ((worldY % TILE_SIZE) * TILE_SIZE + (worldX % TILE_SIZE)) * 4,
      ])
      tiles.set(key, samples)
    }
  }
  return tiles
}

/** Play ten seconds of observed history, retaining gaps, then hold the latest view for five seconds. */
export const renderTimelapse = async ({
  template,
  histories,
  canvas,
  readTile,
  artwork = false,
  readMapTile,
  width = SOCIAL_IMAGE_WIDTH,
  height = SOCIAL_IMAGE_HEIGHT,
  historyEnd,
}: {
  template: Pick<Template, 'bbox' | 'finished'>
  histories: ReadonlyMap<string, readonly PlaybackFrame[]>
  canvas: ReadonlyMap<string, string>
  readTile: (hash: string) => Promise<Uint8Array>
  artwork?: boolean
  readMapTile?: ReadMapTile
  width?: number
  height?: number
  historyEnd?: number
}): Promise<Uint8Array | null> => {
  const samplesByTile = captureSamples(template.bbox, width, height)
  // Reserve one source image per tile for the live hold, retaining both history endpoints.
  const frameLimit = Math.min(
    MAX_FRAMES,
    Math.max(2, Math.floor(MAX_SOURCE_IMAGES / samplesByTile.size) - 1),
  )
  const timeline = sampleTimeline(
    [...histories.values()].flatMap((frames) => frames.map((frame) => frame.bucketStart)),
    frameLimit,
  )
  const times = [...timeline, null]
  const tiles = [...samplesByTile].map(([key, samples]) => {
    const history = [...(histories.get(key) ?? [])].sort((a, b) => a.bucketStart - b.bucketStart)
    const latest = template.finished
      ? history.at(-1)?.hash
      : (canvas.get(key) ?? history.at(-1)?.hash)
    const [tileX, tileY] = key.split('/').map(Number)
    return {
      samples,
      hashes: times.map((time) =>
        time === null ? latest : history.findLast((frame) => frame.bucketStart <= time)?.hash,
      ),
      offsetX:
        artwork && tileX === Math.floor(template.bbox.minX / TILE_SIZE)
          ? template.bbox.minX % TILE_SIZE
          : 0,
      offsetY:
        artwork && tileY === Math.floor(template.bbox.minY / TILE_SIZE)
          ? template.bbox.minY % TILE_SIZE
          : 0,
    }
  })
  if (!tiles.some((tile) => tile.hashes.some((hash) => hash !== undefined))) return null
  const background = readMapTile
    ? await renderBasemap(template.bbox, width, height, readMapTile)
    : Uint8Array.from({ length: width * height * 4 }, (_, i) => BACKGROUND[i % 4])
  const stamp = readMapTile ? await mapAttributionStamp(width, height) : undefined

  /** Redraw one tile's output pixels: its image over the background, or the background alone. */
  const paint = async (canvas: Uint8Array, tile: (typeof tiles)[number], hash?: string) => {
    for (const [target] of tile.samples) canvas.set(background.subarray(target, target + 4), target)
    if (hash === undefined) return
    const image = await decodePng(await readTile(hash))
    if (!artwork && (image.width !== TILE_SIZE || image.height !== TILE_SIZE))
      throw new Error(`Unexpected tile dimensions for ${hash}`)
    for (const [target, source] of tile.samples) {
      const x = ((source / 4) % TILE_SIZE) - tile.offsetX
      const y = Math.floor(source / 4 / TILE_SIZE) - tile.offsetY
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue
      const pixel = (y * image.width + x) * 4
      const alpha = image.pixels[pixel + 3] / 255
      for (let channel = 0; channel < 3; channel++) {
        canvas[target + channel] = Math.round(
          image.pixels[pixel + channel] * alpha + canvas[target + channel] * (1 - alpha),
        )
      }
    }
  }

  // Tiles cover disjoint output pixels, so one canvas carries forward and only changed tiles redraw.
  async function* frames(indices: readonly number[]) {
    const canvas = background.slice()
    const shown = new Map<(typeof tiles)[number], string | undefined>()
    for (const index of indices) {
      for (const tile of tiles) {
        const hash = tile.hashes[index]
        if (shown.get(tile) === hash) continue
        shown.set(tile, hash)
        await paint(canvas, tile, hash)
      }
      const frame = canvas.slice()
      stamp?.(frame)
      yield frame
    }
  }

  return encodeTimelapseGif(frames, width, height, [
    ...timeline,
    historyEnd ?? (timeline.at(-1) ?? 0) + 1,
  ])
}

/** Merge native observations with this version's sparse backfill before rendering. */
export const renderTemplateHistory = async (
  template: Template,
  season: number,
  canvas: ReadonlyMap<string, string>,
  read: (path: string) => Promise<Response>,
  readMapTile?: ReadMapTile,
) => {
  const from = Math.floor(template.createdAt / 1000)
  const to = Math.floor((template.finishedAt ?? Date.now()) / 1000) + 1
  const histories = new Map<string, readonly PlaybackFrame[]>()
  for (const key of captureSamples(template.bbox).keys()) {
    const [x, y] = key.split('/')
    const live: TileHistoryResponse = await (
      await read(`telemetry/tiles/${key}/history?season=${season}&from=${from}&to=${to}`)
    ).json()
    const archive: ArchiveHistory = await (
      await read(
        `archive/templates/${encodeURIComponent(template.id)}?version=${encodeURIComponent(template.version)}&x=${x}&y=${y}`,
      )
    ).json()
    histories.set(
      key,
      mergeArchiveFrames(
        live,
        archive.frames.filter((frame) => frame.at < to),
      ),
    )
  }
  return renderTimelapse({
    template,
    histories,
    canvas,
    readMapTile,
    historyEnd: to,
    readTile: async (hash) =>
      new Uint8Array(
        await (
          await read(
            hash.startsWith('archive:') ? `archive/tiles/${hash.slice(8)}` : `tiles/${hash}`,
          )
        ).arrayBuffer(),
      ),
  })
}
