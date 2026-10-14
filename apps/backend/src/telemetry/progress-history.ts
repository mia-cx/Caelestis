import {
  type ProgressHistoryResponse,
  type ProgressSample,
  seconds,
  type TemplateProgressHistoryResponse,
} from '@caelestis/shared'
import { Effect } from 'effect'
import type { MeasuredTileFrame, TemplateVersionRecord } from '../ports/sql-store.js'
import { SqlStoreService } from '../runtime/backend-runtime.js'
import { SqlStoreReadError } from '../runtime/errors.js'
import { type HistoryRange, selectTileHistoryResolution } from './queries.js'

/** Replay saved tile classifications; placement totals and current status never enter this read. */
export const readProgressHistory = (
  version: TemplateVersionRecord,
  range: HistoryRange,
  resolution = selectTileHistoryResolution(range),
  lifetime?: HistoryRange,
): Effect.Effect<ProgressHistoryResponse, SqlStoreReadError, SqlStoreService> =>
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
    for (const frame of frames) {
      // Folded frames represent an observation somewhere within the bucket. Stamp its end so
      // pixels from later in the interval are never attributed to its start or a moving "now".
      // A replacement can split the selected display bucket. The query filters source
      // observations before downsampling, so its predecessor's final bucket stays before it.
      const at = Math.min(frame.bucketStart + resolution, (lifetime?.toSeconds ?? Infinity) - 1)
      if (at >= range.toSeconds) continue
      const entries = changes.get(at) ?? new Map<string, MeasuredTileFrame>()
      entries.set(`${frame.tileX}/${frame.tileY}`, frame)
      changes.set(at, entries)
    }
    const held = new Map<string, MeasuredTileFrame>()
    const samples: ProgressSample[] = []
    for (const [at, entries] of [...changes].sort(([a], [b]) => a - b)) {
      for (const [key, value] of entries) held.set(key, value)
      const values = [...held.values()]
      const complete =
        held.size === version.chunks.length &&
        values.every((value) => value.correct !== null && value.wrong !== null)
      const correct = values.reduce((sum, value) => sum + (value?.correct ?? 0), 0)
      const mismatched = values.reduce((sum, value) => sum + (value?.wrong ?? 0), 0)
      samples.push({
        at: seconds(at),
        correct: complete ? correct : null,
        mismatched: complete ? mismatched : null,
        total: version.totalPixels,
      })
    }
    return { versionId: version.versionId, resolution, samples }
  })

/** Preserve measurements against the artwork that was active then, rather than today's pixels. */
export const readTemplateProgressHistory = (
  templateId: string,
  range: HistoryRange,
): Effect.Effect<TemplateProgressHistoryResponse, SqlStoreReadError, SqlStoreService> =>
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
      // Replacements need their own coverage. An old version's held tiles cannot fill a new one.
      samples.push({
        at: start,
        correct: null,
        mismatched: null,
        total: version.totalPixels,
        revision: revision.versionId,
        boundary: true,
      })
      const from = resolution === 0 ? start : Math.floor(start / resolution) * resolution
      const history = yield* readProgressHistory(
        version,
        {
          fromSeconds: seconds(from),
          toSeconds: seconds(end),
        },
        resolution,
        lifetime,
      )
      for (const sample of history.samples) {
        if (sample.at >= start && sample.at < end)
          samples.push({ ...sample, revision: revision.versionId })
      }
    }
    return { templateId, resolution, samples }
  })
