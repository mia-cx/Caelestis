import {
  millis,
  type PaintEvent,
  paletteIndexFromWplace,
  type Seconds,
  seconds,
  TILE_SIZE,
  TRANSPARENT_INDEX,
} from '@caelestis/shared'
import { Effect } from 'effect'
import { ingestTimings } from '../metrics/ingest-timing.js'
import type { BlobStore, CounterDelta, CounterStore } from '../ports/index.js'
import {
  BlobStoreService,
  CounterStoreService,
  SqlStoreService,
  StatusReadModelService,
} from '../runtime/backend-runtime.js'
import { type StorageError, storage } from '../runtime/errors.js'
import { bestEffort } from '../status-read-model/port.js'
import type { TileBlobStore } from './blobs/store.js'
import { readDecodedCanvas, readTargetChunk } from './classification.js'
import { type PainterTelemetryBucket, painterBucketResolution } from './history/ladder.js'
import type { ContributionDelta, HistoryStore } from './history/store.js'
import type { TileStore } from './tiles/store.js'

const SECONDS_PER_DAY = 86_400

const dayOf = (timestamp: Seconds): Seconds =>
  seconds(Math.floor(timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY)

const recordPaintPromise = async (
  ports: {
    readonly blobs: BlobStore
    readonly sql: HistoryStore & TileStore & TileBlobStore
    readonly counters: CounterStore
  },
  event: PaintEvent,
  reporterTokenHash: string,
  includeUnpublished: boolean,
): Promise<'duplicate' | 'partial' | 'recorded'> => {
  const seenAt = millis(Date.now())
  const submitted = event.tiles.reduce((total, tile) => total + tile.pixels.x.length, 0)
  if (event.painted === null || event.painted !== submitted) {
    const application = await ports.sql.applyPaintEvent(
      event.eventId,
      event.wplaceUserId,
      event.displayName,
      seenAt,
      { counters: [], contributions: [] },
    )
    return application.applied ? 'partial' : 'duplicate'
  }

  const totals = new Map<string, { placed: number; correct: number; repairs: number }>()
  for (const paintedTile of event.tiles) {
    const tile = { x: paintedTile.x, y: paintedTile.y }
    const targets = (
      await ingestTimings.timed('paint', 'targets', () =>
        ports.sql.listTelemetryTargets(event.season, tile, includeUnpublished),
      )
    ).filter((target) => !target.finished)
    if (targets.length === 0) continue
    const previous = await ingestTimings.timed('paint', 'latestTile', async () => {
      const latest = await ports.sql.readLatestTile(event.season, tile)
      return latest === null ? null : await readDecodedCanvas(ports, latest.hash)
    })

    const classifyStartedAt = performance.now()
    for (const target of targets) {
      const chunk = await readTargetChunk(ports, target)
      if (chunk === null) continue
      const { rect, indices } = chunk
      const total = totals.get(target.templateId) ?? { placed: 0, correct: 0, repairs: 0 }
      for (let index = 0; index < paintedTile.pixels.x.length; index += 1) {
        const x = paintedTile.pixels.x[index] ?? -1
        const y = paintedTile.pixels.y[index] ?? -1
        if (
          x < rect.left ||
          x >= rect.left + rect.width ||
          y < rect.top ||
          y >= rect.top + rect.height
        )
          continue
        const wanted = indices[(y - rect.top) * rect.width + (x - rect.left)] ?? TRANSPARENT_INDEX
        if (wanted === TRANSPARENT_INDEX) continue
        const painted = paletteIndexFromWplace(paintedTile.pixels.colors[index] ?? 0)
        total.placed++
        if (painted !== wanted) continue
        total.correct++
        const before = previous?.[y * TILE_SIZE + x] ?? TRANSPARENT_INDEX
        if (before !== TRANSPARENT_INDEX && before !== wanted) total.repairs++
      }
      totals.set(target.templateId, total)
    }
    ingestTimings.record('paint', 'classify', performance.now() - classifyStartedAt)
  }

  const counters: CounterDelta[] = []
  const contributions: ContributionDelta[] = []
  const painterBuckets: PainterTelemetryBucket[] = []
  // The painter's bucket lands at whichever ladder tier its window has already reached, so a
  // report that arrives after the fold still reads at once instead of hiding under a coarser row.
  const painterResolution = painterBucketResolution(event.ts, seconds(Math.floor(seenAt / 1_000)))
  for (const [templateId, total] of totals) {
    counters.push({ templateId, occurredAt: event.ts, ...total })
    contributions.push({
      templateId,
      wplaceUserId: event.wplaceUserId,
      day: dayOf(event.ts),
      reportedWithToken: reporterTokenHash,
      reportedByUserId: event.wplaceUserId,
      ...total,
    })
    painterBuckets.push({
      templateId,
      wplaceUserId: event.wplaceUserId,
      resolution: painterResolution,
      bucketStart: seconds(Math.floor(event.ts / painterResolution) * painterResolution),
      ...total,
    })
  }
  const application = await ingestTimings.timed('paint', 'apply', () =>
    ports.sql.applyPaintEvent(event.eventId, event.wplaceUserId, event.displayName, seenAt, {
      counters,
      contributions,
      painterBuckets,
    }),
  )
  if (application.accounting === null) return 'duplicate'
  const accounting = application.accounting
  await ingestTimings.timed('paint', 'counters', () =>
    ports.counters.record(accounting.counters, event.eventId),
  )
  return application.applied ? 'recorded' : 'duplicate'
}

/**
 * Classify one fully accepted paint against server-owned template chunks and the tile's latest
 * canvas, applying counters and contributions retry-safely by event id.
 */
export const recordPaint = (
  event: PaintEvent,
  reporterTokenHash: string,
  includeUnpublished: boolean,
): Effect.Effect<
  'duplicate' | 'partial' | 'recorded',
  StorageError,
  BlobStoreService | CounterStoreService | SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const counters = yield* CounterStoreService
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    const result = yield* storage('recordPaint', () =>
      recordPaintPromise({ blobs, counters, sql }, event, reporterTokenHash, includeUnpublished),
    )
    if (result === 'recorded') {
      yield* Effect.promise(() =>
        bestEffort(() => statusReadModel.notifyDashboardChange(event.season)),
      )
    }
    return result
  })
