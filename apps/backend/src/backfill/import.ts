import {
  type ArchiveHistory,
  type ArchiveProgressSample,
  type ArchiveSnapshot,
  type ArchiveTileFrame,
  type BackfillBasis,
  type BackfillJob,
  type BackfillPreview,
  decodeWplaceIndexedPng,
  encodeIndexedPng,
  planTimelapseTiles,
  sha256Hex,
  TILE_SIZE,
  type TileCoord,
  TRANSPARENT_INDEX,
  uuidV7,
} from '@caelestis/shared'
import type { BlobStore, SqlStore, TemplateRecord } from '../ports/index.js'

/** Durable storage needed by the import, independent of the Cloudflare adapter. */
export interface BackfillStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  list<T>(options: { prefix: string; startAfter?: string; limit?: number }): Promise<Map<string, T>>
  delete(keys: string[]): Promise<number>
  setAlarm(at: number): Promise<void>
  deleteAlarm(): Promise<void>
}

/**
 * One bounded page of an import's durable keys. Values are JSON, as every coordinator storage
 * adapter requires. Wakeups stay out: a paused job keeps re-arming while an archive is read.
 */
export type BackfillStatePage = readonly (readonly [string, unknown])[]

export interface ArchiveSource {
  snapshots(): Promise<readonly ArchiveSnapshot[]>
  tile(snapshotId: number, tile: TileCoord): Promise<Uint8Array | null>
}

/** What a job imports, written once at start under `plan`. */
interface StoredPlan {
  readonly jobId: string
  readonly snapshots: readonly ArchiveSnapshot[]
  readonly tiles: readonly TileCoord[]
  /**
   * Steps walk each archive week tile by tile, so one tile's decoded week serves all of its
   * snapshots in a row. Absent on plans moved out of older jobs, which keep stepping snapshot by
   * snapshot, as their step counts were recorded.
   */
  readonly weekly?: true
}

/**
 * Progress, rewritten every step. The counters hold one entry per snapshot of the current week;
 * jobs started before `plan` existed carry their plan inline and a single snapshot's counters.
 */
interface StoredJob extends Partial<Omit<StoredPlan, 'jobId' | 'weekly'>> {
  readonly summary: BackfillJob
  readonly correct: number | readonly number[]
  readonly mismatched: number | readonly number[]
  readonly incomplete: boolean | readonly boolean[]
}

/** Snapshots Eralyon stores in one file per tile: the IDs are hours, and a file holds a week. */
const HOURS_PER_ARCHIVE_WEEK = 168

/** Where a step falls: snapshots step in runs, each run visiting every tile in turn. */
const position = (plan: StoredPlan, completed: number) => {
  const tiles = plan.tiles.length
  let first = 0
  let offset = 0
  while (first < plan.snapshots.length) {
    let length = 1
    const week = Math.floor((plan.snapshots[first]?.id ?? 0) / HOURS_PER_ARCHIVE_WEEK)
    while (
      plan.weekly === true &&
      first + length < plan.snapshots.length &&
      Math.floor((plan.snapshots[first + length]?.id ?? 0) / HOURS_PER_ARCHIVE_WEEK) === week
    )
      length++
    const within = completed - offset
    if (within < length * tiles)
      return {
        first,
        length,
        index: within % length,
        snapshot: plan.snapshots[first + (within % length)],
        tile: plan.tiles[Math.floor(within / length)],
        starts: within === 0,
        /** Every tile has now seen this snapshot, so its sample is complete. */
        samples: Math.floor(within / length) === tiles - 1,
      }
    offset += length * tiles
    first += length
  }
  return null
}

/** A run's counters as stored, or fresh ones. Jobs from before runs held one snapshot's plainly. */
const counters = <T>(held: T | readonly T[], length: number, empty: T): T[] => {
  const list: T[] = Array.isArray(held) ? [...held] : [held]
  return list.length === length ? list : Array.from({ length }, () => empty)
}

interface Observation extends ArchiveTileFrame {
  readonly correct: number
  readonly mismatched: number
}

/** A user-correctable import refusal, distinct from an upstream or storage failure. */
export class BackfillError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}

type DecodedChunk = Awaited<ReturnType<typeof decodeWplaceIndexedPng>>

const suffix = (id: number): string => String(id).padStart(10, '0')
const tilePrefix = (version: string, tile: TileCoord): string =>
  `tile:${version}:${tile.x}/${tile.y}:`
const cutoff = (template: TemplateRecord, now: number): number =>
  Math.floor(
    Math.min(
      now,
      template.finishedAt ?? now,
      template.timelapseFrozen ? (template.timelapseFrozenAt ?? template.updatedAt) : now,
    ) / 1_000,
  )

/** Decoded template chunks kept across steps; a job revisits each of its chunks every snapshot. */
const MAX_DECODED_CHUNKS = 16

/** Resumable import with one tile per alarm. Callers serialize start, cancel and step. */
export class TemplateBackfill {
  private plan: StoredPlan | null = null
  private readonly chunks = new Map<string, Promise<DecodedChunk>>()

  constructor(
    private readonly storage: BackfillStorage,
    private readonly sql: SqlStore,
    private readonly blobs: BlobStore,
    private readonly archive: ArchiveSource,
    private readonly now: () => number = Date.now,
  ) {}

  private async basis(templateId: string): Promise<{ basis: BackfillBasis; end: number }> {
    const template = await this.sql.readTemplate(templateId)
    if (template === null) throw new BackfillError('Template no longer exists.', 404)
    if (template.surface.kind !== 'world' || template.season !== 0)
      throw new BackfillError('Eralyon backfill supports season 0 world templates only.')
    const version =
      template.currentVersionId === null
        ? null
        : await this.sql.readTemplateVersion(template.currentVersionId)
    if (version === null) throw new BackfillError('Template artwork is unavailable.', 409)
    const firstLive = await this.sql.readFirstTemplateObservation(version.versionId)
    return {
      basis: {
        templateId,
        versionId: version.versionId,
        name: template.name,
        season: template.season,
        bbox: version.bbox,
        total: version.totalPixels,
        chunks: version.chunks,
      },
      end: Math.min(cutoff(template, this.now()), firstLive === null ? Infinity : firstLive - 1),
    }
  }

  /** The running job's plan, read once per job rather than rewritten with every step. */
  private async readPlan(held: StoredJob): Promise<StoredPlan | null> {
    const jobId = held.summary.id
    if (held.snapshots !== undefined && held.tiles !== undefined)
      return { jobId, snapshots: held.snapshots, tiles: held.tiles }
    if (this.plan?.jobId !== jobId) this.plan = (await this.storage.get<StoredPlan>('plan')) ?? null
    return this.plan?.jobId === jobId ? this.plan : null
  }

  private decodedChunk(hash: string): Promise<DecodedChunk> {
    let decoded = this.chunks.get(hash)
    if (decoded === undefined) {
      if (this.chunks.size >= MAX_DECODED_CHUNKS) this.chunks.clear()
      decoded = this.blobs
        .get('chunks', hash)
        .then((bytes) => (bytes === null ? null : decodeWplaceIndexedPng(bytes)))
      // A failed read is retried by the next step rather than remembered.
      decoded.catch(() => this.chunks.delete(hash))
      this.chunks.set(hash, decoded)
    }
    return decoded
  }

  async job(): Promise<BackfillJob | null> {
    return (await this.storage.get<StoredJob>('job'))?.summary ?? null
  }

  async preview(templateId: string): Promise<BackfillPreview> {
    const { basis, end } = await this.basis(templateId)
    const snapshots = (await this.archive.snapshots()).filter((snapshot) => snapshot.at <= end)
    return {
      basis,
      snapshots,
      end,
      tileCount: planTimelapseTiles([basis.bbox]).length,
      job: await this.job(),
    }
  }

  async start(templateId: string, versionId: string, fromSnapshot: number): Promise<BackfillJob> {
    const held = await this.job()
    if (held?.status === 'running') {
      await this.storage.setAlarm(this.now() + 100)
      return held
    }
    const preview = await this.preview(templateId)
    if (preview.basis.versionId !== versionId)
      throw new BackfillError('Template artwork changed. Reopen the backfill form.', 409)
    if (!preview.snapshots.some((snapshot) => snapshot.id === fromSnapshot))
      throw new BackfillError('Choose an available snapshot.')
    const snapshots = preview.snapshots.filter((snapshot) => snapshot.id >= fromSnapshot)
    const tiles = planTimelapseTiles([preview.basis.bbox])
    const summary: BackfillJob = {
      id: uuidV7(),
      basis: preview.basis,
      from: snapshots[0]?.at ?? 0,
      to: snapshots.at(-1)?.at ?? 0,
      status: 'running',
      completed: 0,
      total: snapshots.length * tiles.length,
      imported: 0,
      skipped: 0,
      failed: 0,
      error: null,
    }
    await this.storage.put(`basis:${versionId}`, preview.basis)
    // A failed schedule must not leave the form observing an unstartable running job.
    await this.storage.setAlarm(this.now() + 100)
    // The plan lands first, so a stored running job always finds the plan it names.
    await this.storage.put<StoredPlan>('plan', {
      jobId: summary.id,
      snapshots,
      tiles,
      weekly: true,
    })
    await this.storage.put<StoredJob>('job', {
      summary,
      correct: [],
      mismatched: [],
      incomplete: [],
    })
    return summary
  }

  /** Keys sort the same way on every adapter, so `startAfter` resumes a page exactly. */
  async exportState(startAfter: string | null, limit: number): Promise<BackfillStatePage> {
    return [
      ...(await this.storage.list<unknown>({
        prefix: '',
        ...(startAfter === null ? {} : { startAfter }),
        limit,
      })),
    ]
  }

  /** Restore archived state verbatim and wake a running job, which waits out the restore. */
  async importState(page: BackfillStatePage): Promise<void> {
    for (const [key, value] of page) await this.storage.put(key, value)
    const job = page.find(([key]) => key === 'job')?.[1] as StoredJob | undefined
    if (job?.summary.status === 'running') await this.storage.setAlarm(this.now() + 100)
  }

  /** Remove up to `limit` keys of a discarded restore; true once the state and alarm are gone. */
  async discardState(limit: number): Promise<boolean> {
    const keys = [...(await this.storage.list({ prefix: '', limit })).keys()]
    if (keys.length > 0) await this.storage.delete(keys)
    if (keys.length === limit) return false
    await this.storage.deleteAlarm()
    return true
  }

  async cancel(): Promise<BackfillJob | null> {
    const held = await this.storage.get<StoredJob>('job')
    if (held === undefined || held.summary.status !== 'running') return held?.summary ?? null
    const summary: BackfillJob = { ...held.summary, status: 'cancelled' }
    await this.storage.put('job', { ...held, summary })
    return summary
  }

  async history(versionId: string, tile?: TileCoord): Promise<ArchiveHistory> {
    const basis = (await this.storage.get<BackfillBasis>(`basis:${versionId}`)) ?? null
    const firstLive = await this.sql.readFirstTemplateObservation(versionId)
    const samples =
      tile === undefined
        ? [
            ...(
              await this.storage.list<ArchiveProgressSample>({ prefix: `sample:${versionId}:` })
            ).values(),
          ]
        : []
    const frames =
      tile === undefined
        ? []
        : [
            ...(
              await this.storage.list<Observation>({ prefix: tilePrefix(versionId, tile) })
            ).values(),
          ].map(({ at, snapshotId, hash }) => ({ at, snapshotId, hash }))
    const beforeLive = ({ at }: { at: number }) => firstLive === null || at < firstLive
    return {
      source: 'eralyon',
      basis,
      samples: samples.filter(beforeLive),
      frames: frames.filter(beforeLive),
    }
  }

  /** Persist the observation before advancing, making retried alarm deliveries idempotent. */
  async step(): Promise<void> {
    const held = await this.storage.get<StoredJob>('job')
    if (held === undefined || held.summary.status !== 'running') return
    const { summary } = held
    // Rearm before external storage reads too, so a transient D1 failure cannot strand the job.
    await this.storage.setAlarm(this.now() + 60_000)
    // An archive operation is exporting or restoring this state; resume once it ends. The read is
    // fresh because a cached "open" could let this step write after its state was archived.
    if (await this.sql.archiveOperationActive({ fresh: true })) return
    const plan = await this.readPlan(held)
    if (plan === null) return
    const { snapshots } = plan
    const template = await this.sql.readTemplate(summary.basis.templateId)
    if (template === null) {
      await this.cancel()
      return
    }
    const step = position(plan, summary.completed)
    const snapshot = step?.snapshot
    const tile = step?.tile
    if (step === null || snapshot === undefined || tile === undefined) return
    const firstLive = await this.sql.readFirstTemplateObservation(summary.basis.versionId)
    if (firstLive !== null && snapshot.at >= firstLive) {
      // Native history now starts within this run. Its earlier snapshots still need the tiles
      // after this one, so skip only this tile's later snapshots, and stop once none remain.
      const resume = summary.completed + step.length - step.index
      if (step.index > 0 && resume < summary.total) {
        await this.storage.put<StoredJob>('job', {
          ...held,
          summary: { ...summary, completed: resume },
        })
        await this.storage.setAlarm(this.now() + 100)
        return
      }
      // Samples exist for every snapshot all tiles have seen; the job stops here.
      const sampled = step.first + (step.samples ? step.index : 0)
      await this.storage.put<StoredJob>('job', {
        summary: {
          ...summary,
          to:
            snapshots.slice(0, sampled).findLast((entry) => entry.at < firstLive)?.at ??
            summary.from,
          total: summary.completed,
          status: summary.failed > 0 ? 'failed' : 'completed',
        },
        correct: held.correct,
        mismatched: held.mismatched,
        incomplete: held.incomplete,
      })
      return
    }
    if (snapshot.at > cutoff(template, this.now())) {
      await this.cancel()
      return
    }
    const chunk = summary.basis.chunks.find(
      (entry) => entry.tileX === tile.x && entry.tileY === tile.y,
    )
    const key = `${tilePrefix(summary.basis.versionId, tile)}${suffix(snapshot.id)}`
    let observation = await this.storage.get<Observation>(key)
    let imported = 0,
      skipped = 0,
      failed = 0
    let error = summary.error
    try {
      if (observation === undefined) {
        const pixels = await this.archive.tile(snapshot.id, tile)
        let correct = 0,
          mismatched = 0
        let hash: string | null = null
        if (pixels !== null) {
          if (chunk !== undefined) {
            const target = await this.decodedChunk(chunk.hash)
            const { bbox } = summary.basis
            const wraps = bbox.minX > bbox.maxX
            const tileLeft = tile.x * TILE_SIZE
            const highSpan = tileLeft + TILE_SIZE > bbox.minX
            const left = wraps && !highSpan ? 0 : Math.max(0, bbox.minX - tileLeft)
            const right = wraps && highSpan ? TILE_SIZE : Math.min(TILE_SIZE, bbox.maxX - tileLeft)
            const top = Math.max(0, bbox.minY - tile.y * TILE_SIZE)
            const bottom = Math.min(TILE_SIZE, bbox.maxY - tile.y * TILE_SIZE)
            if (target === null || target.width !== right - left || target.height !== bottom - top)
              throw new Error('Template chunk is unavailable or invalid.')
            for (let i = 0; i < target.indices.length; i++) {
              const colour = target.indices[i]
              if (colour === TRANSPARENT_INDEX) continue
              const actual =
                pixels[(top + Math.floor(i / target.width)) * TILE_SIZE + left + (i % target.width)]
              if (colour === actual) correct++
              else if (actual !== TRANSPARENT_INDEX) mismatched++
            }
          }
          const png = await encodeIndexedPng(TILE_SIZE, TILE_SIZE, pixels)
          hash = await sha256Hex(png)
          await this.blobs.put('archives', hash, png)
        }
        observation = { at: snapshot.at, snapshotId: snapshot.id, hash, correct, mismatched }
        await this.storage.put(key, observation)
        if (hash === null) skipped++
        else imported++
      } else skipped++
    } catch (cause) {
      failed++
      error = cause instanceof Error ? cause.message : String(cause)
    }
    // A run's first step starts its counters afresh.
    const correct = counters(step.starts ? [] : held.correct, step.length, 0)
    const mismatched = counters(step.starts ? [] : held.mismatched, step.length, 0)
    const incomplete = counters(step.starts ? [] : held.incomplete, step.length, false)
    correct[step.index] = (correct[step.index] ?? 0) + (observation?.correct ?? 0)
    mismatched[step.index] = (mismatched[step.index] ?? 0) + (observation?.mismatched ?? 0)
    incomplete[step.index] =
      incomplete[step.index] === true || (chunk !== undefined && observation?.hash == null)
    const completed = summary.completed + 1
    if (step.samples) {
      const unknown = incomplete[step.index] === true
      await this.storage.put<ArchiveProgressSample>(
        `sample:${summary.basis.versionId}:${suffix(snapshot.id)}`,
        {
          at: snapshot.at,
          snapshotId: snapshot.id,
          correct: unknown ? null : (correct[step.index] ?? 0),
          mismatched: unknown ? null : (mismatched[step.index] ?? 0),
          total: summary.basis.total,
        },
      )
    }
    const next: BackfillJob = {
      ...summary,
      completed,
      imported: summary.imported + imported,
      skipped: summary.skipped + skipped,
      failed: summary.failed + failed,
      error,
      status:
        completed === summary.total
          ? summary.failed + failed > 0
            ? 'failed'
            : 'completed'
          : 'running',
    }
    if (held.snapshots !== undefined) await this.storage.put<StoredPlan>('plan', plan)
    await this.storage.put<StoredJob>('job', {
      summary: next,
      correct,
      mismatched,
      incomplete,
    })
    if (next.status === 'running') await this.storage.setAlarm(this.now() + 100)
  }
}
