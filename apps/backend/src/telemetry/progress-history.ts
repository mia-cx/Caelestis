import {
  type ProgressHistoryResponse,
  type ProgressSample,
  type Seconds,
  seconds,
  type TemplateProgressHistoryResponse,
  tileKey,
} from '@caelestis/shared'
import { Effect } from 'effect'
import type { BlobStore } from '../ports/index.js'
import { BlobStoreService, SqlStoreService } from '../runtime/backend-runtime.js'
import { NotFoundError, StorageError, storage } from '../runtime/errors.js'
import type { TemplateVersionRecord } from '../templates/store.js'
import type { TileBlobStore } from './blobs/store.js'
import { type ClassificationTarget, classifyTarget, readDecodedCanvas } from './classification.js'
import { type HistoryRange, selectTileHistoryResolution } from './queries.js'
import type { MeasuredTileFrame, TileMeasurement, TileStore } from './tiles/store.js'

/** Derive counts for a retained canvas image against one artwork revision. */
const readHistoricalTileMeasurement = async (
  ports: { readonly blobs: BlobStore; readonly sql: TileStore & TileBlobStore },
  target: ClassificationTarget,
  hash: string,
): Promise<TileMeasurement | null> => {
  const canvas = await readDecodedCanvas(ports, hash)
  if (canvas === null) return null
  const classified = await classifyTarget(ports, target, canvas, hash)
  if (classified === null) return null
  const { correct, wrong, blank } = classified
  return { hash, correct, wrong, blank }
}

/** Unmeasured frames classified at once: each holds a decoded 1000×1000 canvas while it runs. */
const CLASSIFY_CONCURRENCY = 8

/** Replay retained canvas images, caching missing classifications against their historical artwork. */
export const readProgressHistory = (
  version: TemplateVersionRecord,
  range: HistoryRange,
  resolution = selectTileHistoryResolution(range),
  lifetime?: HistoryRange,
  initialAt?: Seconds,
  notBefore?: Seconds,
): Effect.Effect<ProgressHistoryResponse, StorageError, SqlStoreService | BlobStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    if (version.surface.kind !== 'world')
      return { versionId: version.versionId, resolution, samples: [] }
    const changes = new Map<number, Map<string, MeasuredTileFrame>>()
    const frames = yield* storage('readTemplateProgressFrames', () =>
      sql.readTemplateProgressFrames(
        version.versionId,
        range.fromSeconds,
        range.toSeconds,
        resolution,
        lifetime,
      ),
    )
    // Canvas observations survive artwork updates. Reclassify the last known frame on each
    // tile against the new artwork instead of waiting for every tile to be reported again.
    const initial =
      initialAt === undefined
        ? []
        : yield* storage('readTemplateProgressAt', () =>
            sql.readTemplateProgressAt(version.versionId, initialAt, notBefore),
          )
    const blobs = yield* BlobStoreService
    const chunks = new Map(
      version.chunks.map((chunk) => [tileKey({ x: chunk.tileX, y: chunk.tileY }), chunk]),
    )
    const classified = new Map<MeasuredTileFrame, MeasuredTileFrame>()
    yield* Effect.forEach(
      [...initial, ...frames],
      (frame) => {
        const chunk = chunks.get(tileKey({ x: frame.tileX, y: frame.tileY }))
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
          catch: (cause) => new StorageError({ operation: 'classifyProgressHistory', cause }),
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
      entries.set(tileKey({ x: frame.tileX, y: frame.tileY }), frame)
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
      hold(tileKey({ x: frame.tileX, y: frame.tileY }), classified.get(frame) ?? frame)
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
  notBefore?: Seconds,
): Effect.Effect<
  TemplateProgressHistoryResponse,
  StorageError,
  SqlStoreService | BlobStoreService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const resolution = selectTileHistoryResolution(range)
    const versions = yield* storage('listTemplateVersions', () =>
      sql.listTemplateVersions(templateId),
    )
    const samples: ProgressSample[] = []
    for (const [index, revision] of versions.entries()) {
      const start = Math.max(range.fromSeconds, Math.floor(revision.createdAt / 1_000))
      const next = versions[index + 1]
      const lifetime = {
        fromSeconds: seconds(Math.max(notBefore ?? 0, Math.floor(revision.createdAt / 1_000))),
        toSeconds: seconds(
          next === undefined ? Number.MAX_SAFE_INTEGER : Math.floor(next.createdAt / 1_000),
        ),
      }
      const end = Math.min(
        range.toSeconds,
        next === undefined ? Infinity : Math.floor(next.createdAt / 1_000),
      )
      if (start >= end) continue
      const version = yield* storage('readTemplateVersion', () =>
        sql.readTemplateVersion(revision.versionId),
      )
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
        notBefore,
      )
      for (const sample of history.samples) {
        if (sample.at >= start && sample.at < end)
          samples.push({ ...sample, revision: revision.versionId })
      }
    }
    return { templateId, resolution, samples }
  })

/**
 * One template's progress across its versions, or one version's when `versionId` is named. An
 * unpublished template answers as though it did not exist.
 */
export const readVisibleProgressHistory = (
  templateId: string,
  versionId: string | undefined,
  range: HistoryRange,
  includeUnpublished: boolean,
  notBefore?: Seconds,
): Effect.Effect<
  TemplateProgressHistoryResponse | ProgressHistoryResponse,
  StorageError | NotFoundError,
  SqlStoreService | BlobStoreService
> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const template = yield* storage('readTemplate', () => sql.readTemplate(templateId))
    if (template === null || (!includeUnpublished && !template.published))
      return yield* Effect.fail(new NotFoundError({ message: 'Template not found.' }))
    if (versionId === undefined)
      return yield* readTemplateProgressHistory(templateId, range, notBefore)
    const version = yield* storage('readTemplateVersion', () => sql.readTemplateVersion(versionId))
    if (version?.templateId !== templateId)
      return yield* Effect.fail(new NotFoundError({ message: 'Template version not found.' }))
    return yield* readProgressHistory(version, range)
  })
