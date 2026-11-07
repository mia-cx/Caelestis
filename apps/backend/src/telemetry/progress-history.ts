import {
  type ProgressHistoryResponse,
  type ProgressSample,
  type Seconds,
  seconds,
  type TemplateProgressHistoryResponse,
} from '@caelestis/shared'
import { Effect } from 'effect'
import type { MeasuredTileFrame, TemplateVersionRecord } from '../ports/sql-store.js'
import { BlobStoreService, SqlStoreService } from '../runtime/backend-runtime.js'
import { SqlStoreReadError, TelemetryStorageError } from '../runtime/errors.js'
import { readHistoricalTileMeasurement } from './ingest.js'
import { type HistoryRange, selectTileHistoryResolution } from './queries.js'

/** Unmeasured frames classified at once: each holds a decoded 1000×1000 canvas while it runs. */
const CLASSIFY_CONCURRENCY = 8
const tileOf = (x: number, y: number): string => `${x}/${y}`

/** Replay retained canvas images, caching missing classifications against their historical artwork. */
export const readProgressHistory = (
  version: TemplateVersionRecord,
  range: HistoryRange,
  resolution = selectTileHistoryResolution(range),
  lifetime?: HistoryRange,
  initialAt?: Seconds,
): Effect.Effect<
  ProgressHistoryResponse,
  SqlStoreReadError | TelemetryStorageError,
  SqlStoreService | BlobStoreService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    if (version.surface.kind !== 'world')
      return { versionId: version.versionId, resolution, samples: [] }
    const changes = new Map<number, Map<string, MeasuredTileFrame>>()
    const frames = yield* Effect.tryPromise({
      try: () =>
        sql.readTemplateProgressFrames(
          version.versionId,
          range.fromSeconds,
          range.toSeconds,
          resolution,
          lifetime,
        ),
      catch: (cause) => new SqlStoreReadError({ operation: 'readTemplateProgressFrames', cause }),
    })
    // Canvas observations survive artwork updates. Reclassify the last known frame on each
    // tile against the new artwork instead of waiting for every tile to be reported again.
    const initial =
      initialAt === undefined
        ? []
        : yield* Effect.tryPromise({
            try: () => sql.readTemplateProgressAt(version.versionId, initialAt),
            catch: (cause) => new SqlStoreReadError({ operation: 'readTemplateProgressAt', cause }),
          })
    const blobs = yield* BlobStoreService
    const chunks = new Map(version.chunks.map((chunk) => [tileOf(chunk.tileX, chunk.tileY), chunk]))
    const classified = new Map<MeasuredTileFrame, MeasuredTileFrame>()
    yield* Effect.forEach(
      [...initial, ...frames],
      (frame) => {
        const chunk = chunks.get(tileOf(frame.tileX, frame.tileY))
        if (chunk === undefined || (frame.correct !== null && frame.wrong !== null))
          return Effect.void
        const target = {
          ...chunk,
          templateId: version.templateId,
          versionId: version.versionId,
          bbox: version.bbox,
        }
        return Effect.tryPromise({
          try: async () => {
            const measurement = await readHistoricalTileMeasurement(
              { blobs, sql },
              target,
              frame.hash,
              frame.bucketStart * 1_000,
            )
            if (measurement === null) return
            await sql.writeTileMeasurements(version.versionId, { x: chunk.tileX, y: chunk.tileY }, [
              measurement,
            ])
            classified.set(frame, {
              ...frame,
              correct: measurement.correct,
              wrong: measurement.wrong,
            })
          },
          catch: (cause) =>
            new TelemetryStorageError({ operation: 'classifyProgressHistory', cause }),
        })
      },
      { concurrency: CLASSIFY_CONCURRENCY, discard: true },
    )
    for (const storedFrame of frames) {
      const frame = classified.get(storedFrame) ?? storedFrame
      // Folded observations are stamped at the bucket's end, within this artwork's lifetime.
      const at = Math.min(frame.bucketStart + resolution, (lifetime?.toSeconds ?? Infinity) - 1)
      if (at >= range.toSeconds) continue
      const entries = changes.get(at) ?? new Map<string, MeasuredTileFrame>()
      entries.set(tileOf(frame.tileX, frame.tileY), frame)
      changes.set(at, entries)
    }
    // Running totals over the latest frame per tile, so each sample costs only its own changes.
    const held = new Map<string, MeasuredTileFrame>()
    let correct = 0
    let mismatched = 0
    let unmeasured = 0
    const hold = (key: string, frame: MeasuredTileFrame) => {
      const previous = held.get(key)
      if (previous !== undefined) {
        correct -= previous.correct ?? 0
        mismatched -= previous.wrong ?? 0
        if (previous.correct === null || previous.wrong === null) unmeasured--
      }
      held.set(key, frame)
      correct += frame.correct ?? 0
      mismatched += frame.wrong ?? 0
      if (frame.correct === null || frame.wrong === null) unmeasured++
    }
    for (const frame of initial)
      hold(tileOf(frame.tileX, frame.tileY), classified.get(frame) ?? frame)
    if (initialAt !== undefined && !changes.has(initialAt)) changes.set(initialAt, new Map())
    const samples: ProgressSample[] = []
    for (const [at, entries] of [...changes].sort(([a], [b]) => a - b)) {
      for (const [key, value] of entries) hold(key, value)
      const complete = held.size === version.chunks.length && unmeasured === 0
      samples.push({
        at: seconds(at),
        correct: complete ? correct : null,
        mismatched: complete ? mismatched : null,
        total: version.totalPixels,
        ...(at === initialAt ? { boundary: true as const } : {}),
      })
    }
    return { versionId: version.versionId, resolution, samples }
  })

/** Preserve measurements against the artwork that was active then, rather than today's pixels. */
export const readTemplateProgressHistory = (
  templateId: string,
  range: HistoryRange,
): Effect.Effect<
  TemplateProgressHistoryResponse,
  SqlStoreReadError | TelemetryStorageError,
  SqlStoreService | BlobStoreService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const resolution = selectTileHistoryResolution(range)
    const versions = yield* Effect.tryPromise({
      try: () => sql.listTemplateVersions(templateId),
      catch: (cause) => new SqlStoreReadError({ operation: 'listTemplateVersions', cause }),
    })
    const samples: ProgressSample[] = []
    for (const [index, revision] of versions.entries()) {
      const start = Math.max(range.fromSeconds, Math.floor(revision.createdAt / 1_000))
      const next = versions[index + 1]
      const lifetime = {
        fromSeconds: seconds(Math.floor(revision.createdAt / 1_000)),
        toSeconds: seconds(
          next === undefined ? Number.MAX_SAFE_INTEGER : Math.floor(next.createdAt / 1_000),
        ),
      }
      const end = Math.min(
        range.toSeconds,
        next === undefined ? Infinity : Math.floor(next.createdAt / 1_000),
      )
      if (start >= end) continue
      const version = yield* Effect.tryPromise({
        try: () => sql.readTemplateVersion(revision.versionId),
        catch: (cause) => new SqlStoreReadError({ operation: 'readTemplateVersion', cause }),
      })
      if (version === null || version.surface.kind !== 'world') continue
      const from = resolution === 0 ? start : Math.floor(start / resolution) * resolution
      const history = yield* readProgressHistory(
        version,
        {
          fromSeconds: seconds(from),
          toSeconds: seconds(end),
        },
        resolution,
        lifetime,
        seconds(start),
      )
      for (const sample of history.samples) {
        if (sample.at >= start && sample.at < end)
          samples.push({ ...sample, revision: revision.versionId })
      }
    }
    return { templateId, resolution, samples }
  })
