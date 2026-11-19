import {
  type ArchiveHistory,
  type ArchiveProgressSample,
  type ArchiveSnapshot,
  type ArchiveTileFrame,
  type BackfillBasis,
  type BackfillJob,
  type BackfillPreview,
  type BackfillProgress,
  encodeIndexedPng,
  type FolderBackfillJob,
  type FolderBackfillPreview,
  planTimelapseTiles,
  sha256Hex,
  TILE_SIZE,
  type TileCoord,
  templatesInFolderSubtree,
  uuidV7,
} from '@caelestis/shared'
import type { BlobStore, SqlStore, TemplateRecord } from '../ports/index.js'
import { classifyChunk, readTargetChunk } from '../telemetry/classification.js'
import {
  type ArchiveSource,
  archiveWeek,
  BackfillError,
  type BackfillImporter,
  type BackfillSink,
  type BackfillStatePage,
  type BackfillStorage,
} from './port.js'

/** A wakeup that continues a running job almost at once. */
const NEXT_STEP_DELAY_MILLISECONDS = 100
/** Armed before each step's reads, so a transient failure cannot strand the job. */
const RETRY_STEP_DELAY_MILLISECONDS = 60_000

/** What a job imports, written once at start under `plan`. */
interface StoredPlan {
  readonly jobId: string
  readonly snapshots: readonly ArchiveSnapshot[]
  /** Every tile any of the job's templates covers; each is read once per snapshot. */
  readonly tiles: readonly TileCoord[]
  /**
   * Steps walk each archive week tile by tile, so one tile's decoded week serves all of its
   * snapshots in a row. Absent on plans moved out of older jobs, which keep stepping snapshot by
   * snapshot, as their step counts were recorded.
   */
  readonly weekly?: true
  /** The templates the job scores. Absent on template plans from before folder imports. */
  readonly bases?: readonly BackfillBasis[]
}

/** One template's counters for a run of snapshots, one entry per snapshot. */
interface Run {
  /** Index of the run's first snapshot in the plan, so counters never leak into the next run. */
  readonly first: number
  readonly correct: number[]
  readonly mismatched: number[]
  readonly incomplete: boolean[]
}

/** Progress, rewritten every step. */
interface StoredJob extends Partial<Omit<StoredPlan, 'jobId' | 'weekly' | 'bases'>> {
  readonly summary: BackfillJob | FolderBackfillJob
  /** Counters by template version. */
  readonly runs?: Readonly<Record<string, Run>>
  /** The latest snapshot any template was scored at, which a finished job reports as `to`. */
  readonly reached?: number | null
  /**
   * One template's counters, as jobs stored them before folder imports: one entry per snapshot of
   * the current run, or a single snapshot's before runs existed. They carry their plan inline too.
   */
  readonly correct?: number | readonly number[]
  readonly mismatched?: number | readonly number[]
  readonly incomplete?: boolean | readonly boolean[]
}

/** Tile reads no template needs any more, passed over in one wakeup before it yields. */
const MAX_SKIPS_PER_STEP = 1_000

/** Where a step falls: snapshots step in runs, each run visiting every tile in turn. */
const position = (plan: StoredPlan, completed: number) => {
  const tiles = plan.tiles.length
  let first = 0
  let offset = 0
  while (first < plan.snapshots.length) {
    let length = 1
    const week = archiveWeek(plan.snapshots[first]?.id ?? 0)
    while (
      plan.weekly === true &&
      first + length < plan.snapshots.length &&
      archiveWeek(plan.snapshots[first + length]?.id ?? 0) === week
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

/** A template's import basis and the last second its archive history may cover. */
interface Candidate {
  readonly basis: BackfillBasis
  readonly end: number
}

const suffix = (id: number): string => String(id).padStart(10, '0')
const tileKey = (tile: TileCoord): string => `${tile.x}/${tile.y}`
const tilePrefix = (version: string, tile: TileCoord): string => `tile:${version}:${tileKey(tile)}:`
const cutoff = (template: TemplateRecord, now: number): number =>
  Math.floor(
    Math.min(
      now,
      template.finishedAt ?? now,
      template.timelapseFrozen ? (template.timelapseFrozenAt ?? template.updatedAt) : now,
    ) / 1_000,
  )
const historyEnd = (template: TemplateRecord, firstLive: number | null, now: number): number =>
  Math.min(cutoff(template, now), firstLive === null ? Infinity : firstLive - 1)

/** A new job's counters, with every tile of every chosen snapshot still ahead. */
const progress = (
  snapshots: readonly ArchiveSnapshot[],
  tiles: readonly TileCoord[],
): BackfillProgress => ({
  id: uuidV7(),
  from: snapshots[0]?.at ?? 0,
  to: snapshots.at(-1)?.at ?? 0,
  status: 'running',
  completed: 0,
  total: snapshots.length * tiles.length,
  imported: 0,
  skipped: 0,
  failed: 0,
  error: null,
})

/**
 * Resumable import with one archive tile read per alarm, scored against every template of the
 * job that covers the tile. A template object imports that template alone; a folder object
 * imports every template below the folder and writes each one's results to its own object.
 * Callers serialize start, cancel and step.
 */
export class TemplateBackfill implements BackfillImporter {
  private plan: StoredPlan | null = null
  private layout: {
    readonly jobId: string
    readonly covers: ReadonlyMap<string, ReadonlySet<string>>
    readonly last: ReadonlyMap<string, string>
  } | null = null
  private readonly local: BackfillSink = {
    get: (key) => this.storage.get(key),
    put: async (entries) => {
      for (const [key, value] of entries) await this.storage.put(key, value)
    },
  }

  constructor(
    private readonly storage: BackfillStorage,
    private readonly sql: SqlStore,
    private readonly blobs: BlobStore,
    private readonly archive: ArchiveSource,
    private readonly now: () => number = Date.now,
    /** Each template's own state, for folder imports. */
    private readonly templates?: (templateId: string) => BackfillSink,
  ) {}

  private async basis(templateId: string): Promise<Candidate> {
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
      end: historyEnd(template, firstLive, this.now()),
    }
  }

  /** Every template below a folder that has artwork to compare against. */
  private async folder(nodeId: string): Promise<readonly Candidate[]> {
    const node = await this.sql.readNode(nodeId)
    if (node === null) throw new BackfillError('Folder no longer exists.', 404)
    if (node.surface.kind !== 'world' || node.season !== 0)
      throw new BackfillError('Eralyon backfill supports season 0 world folders only.')
    const scope = { season: node.season, surface: node.surface }
    const [nodes, templates] = await Promise.all([
      this.sql.listNodes(scope.season, scope.surface),
      this.sql.listManifestTemplates(scope, true),
    ])
    const candidates = await Promise.all(
      templatesInFolderSubtree(nodes, templates, nodeId).map((template) =>
        this.basis(template.id).catch((error: unknown) => {
          // A template without artwork has nothing to compare; the rest still import.
          if (error instanceof BackfillError) return null
          throw error
        }),
      ),
    )
    const found = candidates.filter((candidate) => candidate !== null)
    if (found.length === 0)
      throw new BackfillError('This folder has no templates to backfill.', 409)
    return found
  }

  /** The running job's plan, read once per job rather than rewritten with every step. */
  private async readPlan(held: StoredJob): Promise<StoredPlan | null> {
    const jobId = held.summary.id
    if (held.snapshots !== undefined && held.tiles !== undefined)
      return { jobId, snapshots: held.snapshots, tiles: held.tiles }
    if (this.plan?.jobId !== jobId) this.plan = (await this.storage.get<StoredPlan>('plan')) ?? null
    return this.plan?.jobId === jobId ? this.plan : null
  }

  /** Which plan tiles each template covers, and the tile that completes its snapshot samples. */
  private layoutOf(plan: StoredPlan, bases: readonly BackfillBasis[]) {
    if (this.layout?.jobId === plan.jobId) return this.layout
    const covers = new Map(
      bases.map((basis) => [
        basis.versionId,
        new Set(planTimelapseTiles([basis.bbox]).map(tileKey)),
      ]),
    )
    const last = new Map<string, string>()
    for (const tile of plan.tiles)
      for (const [version, tiles] of covers)
        if (tiles.has(tileKey(tile))) last.set(version, tileKey(tile))
    this.layout = { jobId: plan.jobId, covers, last }
    return this.layout
  }

  private sinkFor(summary: StoredJob['summary']): (templateId: string) => BackfillSink {
    if ('basis' in summary) return () => this.local
    if (this.templates === undefined) throw new Error('Folder backfill needs template state.')
    return this.templates
  }

  /** Compare one archived tile with the template's artwork on it, as live telemetry would. */
  private async score(basis: BackfillBasis, tile: TileCoord, pixels: Uint8Array) {
    const chunk = basis.chunks.find((entry) => entry.tileX === tile.x && entry.tileY === tile.y)
    if (chunk === undefined) return { correct: 0, mismatched: 0 }
    const target = await readTargetChunk(
      { blobs: this.blobs },
      {
        templateId: basis.templateId,
        versionId: basis.versionId,
        bbox: basis.bbox,
        ...chunk,
      },
    )
    if (target === null) throw new Error('Template chunk is unavailable or invalid.')
    const { correct, wrong } = classifyChunk(target.indices, pixels, target.rect)
    return { correct, mismatched: wrong }
  }

  /** This template object's own import, or null. */
  async job(): Promise<BackfillJob | null> {
    const summary = (await this.storage.get<StoredJob>('job'))?.summary
    return summary !== undefined && 'basis' in summary ? summary : null
  }

  /** This folder object's import, or null. */
  async folderJob(): Promise<FolderBackfillJob | null> {
    const summary = (await this.storage.get<StoredJob>('job'))?.summary
    return summary !== undefined && 'templateIds' in summary ? summary : null
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

  /** Snapshots run to the latest cutoff of any template below the folder. */
  async previewFolder(nodeId: string): Promise<FolderBackfillPreview> {
    const candidates = await this.folder(nodeId)
    const end = Math.max(...candidates.map((candidate) => candidate.end))
    return {
      bases: candidates.map((candidate) => candidate.basis),
      snapshots: (await this.archive.snapshots()).filter((snapshot) => snapshot.at <= end),
      end,
      tileCount: planTimelapseTiles(candidates.map((candidate) => candidate.basis.bbox)).length,
      job: await this.folderJob(),
    }
  }

  /** Record the bases and plan, then the running job that names them. */
  private async begin<J extends BackfillJob | FolderBackfillJob>(
    summary: J,
    bases: readonly BackfillBasis[],
    snapshots: readonly ArchiveSnapshot[],
    tiles: readonly TileCoord[],
  ): Promise<J> {
    const sink = this.sinkFor(summary)
    for (const basis of bases)
      await sink(basis.templateId).put([[`basis:${basis.versionId}`, basis]])
    // A failed schedule must not leave the form observing an unstartable running job.
    await this.storage.setAlarm(this.now() + NEXT_STEP_DELAY_MILLISECONDS)
    // The plan lands first, so a stored running job always finds the plan it names.
    await this.storage.put<StoredPlan>('plan', {
      jobId: summary.id,
      snapshots,
      tiles,
      weekly: true,
      bases,
    })
    await this.storage.put<StoredJob>('job', { summary, runs: {}, reached: null })
    return summary
  }

  async start(templateId: string, versionId: string, fromSnapshot: number): Promise<BackfillJob> {
    const held = await this.job()
    if (held?.status === 'running') {
      await this.storage.setAlarm(this.now() + NEXT_STEP_DELAY_MILLISECONDS)
      return held
    }
    const preview = await this.preview(templateId)
    if (preview.basis.versionId !== versionId)
      throw new BackfillError('Template artwork changed. Reopen the backfill form.', 409)
    if (!preview.snapshots.some((snapshot) => snapshot.id === fromSnapshot))
      throw new BackfillError('Choose an available snapshot.')
    const snapshots = preview.snapshots.filter((snapshot) => snapshot.id >= fromSnapshot)
    const tiles = planTimelapseTiles([preview.basis.bbox])
    const summary = { ...progress(snapshots, tiles), basis: preview.basis }
    return this.begin(summary, [preview.basis], snapshots, tiles)
  }

  /**
   * Import every template below a folder from one snapshot on. `versionIds` is the artwork the
   * form showed, so a template added, removed or redrawn since then asks for a fresh look.
   */
  async startFolder(
    nodeId: string,
    versionIds: readonly string[],
    fromSnapshot: number,
  ): Promise<FolderBackfillJob> {
    const held = await this.folderJob()
    if (held?.status === 'running') {
      await this.storage.setAlarm(this.now() + NEXT_STEP_DELAY_MILLISECONDS)
      return held
    }
    const candidates = await this.folder(nodeId)
    const shown = new Set(versionIds)
    if (
      shown.size !== candidates.length ||
      candidates.some((candidate) => !shown.has(candidate.basis.versionId))
    )
      throw new BackfillError('Folder contents or artwork changed. Reopen the backfill form.', 409)
    const end = Math.max(...candidates.map((candidate) => candidate.end))
    const snapshots = (await this.archive.snapshots()).filter(
      (snapshot) => snapshot.at <= end && snapshot.id >= fromSnapshot,
    )
    const from = snapshots[0]
    if (from?.id !== fromSnapshot) throw new BackfillError('Choose an available snapshot.')
    // Templates whose native history already starts by then have nothing to import.
    const bases = candidates
      .filter((candidate) => candidate.end >= from.at)
      .map((candidate) => candidate.basis)
    const tiles = planTimelapseTiles(bases.map((basis) => basis.bbox))
    const summary = {
      ...progress(snapshots, tiles),
      templateIds: bases.map((basis) => basis.templateId),
    }
    return this.begin(summary, bases, snapshots, tiles)
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

  /** One key of this object's state, for a folder import deciding whether a tile is done. */
  async readState<T>(key: string): Promise<T | undefined> {
    return this.storage.get<T>(key)
  }

  /** Restore archived state verbatim and wake a running job, which waits out the restore. */
  async importState(page: BackfillStatePage): Promise<void> {
    for (const [key, value] of page) await this.storage.put(key, value)
    const job = page.find(([key]) => key === 'job')?.[1] as StoredJob | undefined
    if (job?.summary.status === 'running')
      await this.storage.setAlarm(this.now() + NEXT_STEP_DELAY_MILLISECONDS)
  }

  /** Remove up to `limit` keys of a discarded restore; true once the state and alarm are gone. */
  async discardState(limit: number): Promise<boolean> {
    const keys = [...(await this.storage.list({ prefix: '', limit })).keys()]
    if (keys.length > 0) await this.storage.delete(keys)
    if (keys.length === limit) return false
    await this.storage.deleteAlarm()
    return true
  }

  private async stop(): Promise<StoredJob['summary'] | null> {
    const held = await this.storage.get<StoredJob>('job')
    if (held === undefined || held.summary.status !== 'running') return held?.summary ?? null
    const summary = { ...held.summary, status: 'cancelled' as const }
    await this.storage.put<StoredJob>('job', { ...held, summary })
    return summary
  }

  async cancel(): Promise<BackfillJob | null> {
    const summary = await this.stop()
    return summary !== null && 'basis' in summary ? summary : null
  }

  async cancelFolder(): Promise<FolderBackfillJob | null> {
    const summary = await this.stop()
    return summary !== null && 'templateIds' in summary ? summary : null
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

  /**
   * Read one archive tile and score it against every template still importing there, passing
   * over reads no template needs. Observations persist before progress advances, making retried
   * alarm deliveries idempotent.
   */
  async step(): Promise<void> {
    const held = await this.storage.get<StoredJob>('job')
    if (held === undefined || held.summary.status !== 'running') return
    // Rearm before external storage reads too, so a transient D1 failure cannot strand the job.
    await this.storage.setAlarm(this.now() + RETRY_STEP_DELAY_MILLISECONDS)
    // An archive operation is exporting or restoring this state; resume once it ends. The read is
    // fresh because a cached "open" could let this step write after its state was archived.
    if (await this.sql.archiveOperationActive({ fresh: true })) return
    const plan = await this.readPlan(held)
    if (plan === null) return
    const bases = plan.bases ?? ('basis' in held.summary ? [held.summary.basis] : [])
    const { covers, last } = this.layoutOf(plan, bases)
    const sink = this.sinkFor(held.summary)

    // Each template's history end, read once per wakeup; null once the template is deleted.
    const ends = new Map<string, Promise<number | null>>()
    const endOf = (basis: BackfillBasis): Promise<number | null> => {
      let end = ends.get(basis.versionId)
      if (end === undefined) {
        end = Promise.all([
          this.sql.readTemplate(basis.templateId),
          this.sql.readFirstTemplateObservation(basis.versionId),
        ]).then(([template, firstLive]) =>
          template === null ? null : historyEnd(template, firstLive, this.now()),
        )
        ends.set(basis.versionId, end)
      }
      return end
    }

    let summary = held.summary
    let reached = held.reached ?? null
    const runs: Record<string, Run> = { ...held.runs }
    const firstStep = position(plan, summary.completed)
    const only = bases[0]
    // Counters stored before folder imports belong to the run in progress, if one is.
    if (held.runs === undefined && only !== undefined && firstStep !== null && !firstStep.starts)
      runs[only.versionId] = {
        first: firstStep.first,
        correct: counters(held.correct ?? 0, firstStep.length, 0),
        mismatched: counters(held.mismatched ?? 0, firstStep.length, 0),
        incomplete: counters(held.incomplete ?? false, firstStep.length, false),
      }

    for (let skips = 0; summary.completed < summary.total && skips < MAX_SKIPS_PER_STEP; skips++) {
      const step = position(plan, summary.completed)
      const snapshot = step?.snapshot
      const tile = step?.tile
      if (step === null || snapshot === undefined || tile === undefined) return
      const runOf = (basis: BackfillBasis): Run => {
        const run = runs[basis.versionId]
        const fresh = run === undefined || run.first !== step.first
        const next: Run = {
          first: step.first,
          correct: counters(fresh ? [] : run.correct, step.length, 0),
          mismatched: counters(fresh ? [] : run.mismatched, step.length, 0),
          incomplete: counters(fresh ? [] : run.incomplete, step.length, false),
        }
        runs[basis.versionId] = next
        return next
      }

      const covering = bases.filter((basis) => covers.get(basis.versionId)?.has(tileKey(tile)))
      const coveringEnds = await Promise.all(covering.map(endOf))
      const active = covering.filter((_, i) => snapshot.at <= (coveringEnds[i] ?? -Infinity))
      if (coveringEnds.includes(null)) {
        const all = await Promise.all(bases.map(endOf))
        if (all.every((end) => end === null)) {
          await this.stop()
          return
        }
      }
      // A template that has stopped importing leaves this snapshot's sample unknown, should its
      // cutoff move later again before the snapshot's last tile.
      for (const basis of covering)
        if (!active.includes(basis)) runOf(basis).incomplete[step.index] = true

      if (active.length === 0) {
        // Every template here has native history or has stopped: nothing to read.
        summary = { ...summary, completed: summary.completed + 1, skipped: summary.skipped + 1 }
        continue
      }

      const key = (basis: BackfillBasis) =>
        `${tilePrefix(basis.versionId, tile)}${suffix(snapshot.id)}`
      const observations = new Map<string, Observation | undefined>()
      let imported = 0,
        skipped = 0,
        failed = 0
      let error = summary.error
      try {
        const stored = await Promise.all(
          active.map((basis) => sink(basis.templateId).get<Observation>(key(basis))),
        )
        for (const [i, basis] of active.entries()) observations.set(basis.versionId, stored[i])
        const missing = active.filter((basis) => observations.get(basis.versionId) === undefined)
        if (missing.length === 0) skipped++
        else {
          const pixels = await this.archive.tile(snapshot.id, tile)
          const scores = await Promise.all(
            missing.map((basis) =>
              pixels === null ? { correct: 0, mismatched: 0 } : this.score(basis, tile, pixels),
            ),
          )
          let hash: string | null = null
          if (pixels !== null) {
            const png = await encodeIndexedPng(TILE_SIZE, TILE_SIZE, pixels)
            hash = await sha256Hex(png)
            await this.blobs.put('archives', hash, png)
          }
          for (const [i, basis] of missing.entries()) {
            const observation = {
              at: snapshot.at,
              snapshotId: snapshot.id,
              hash,
              correct: scores[i]?.correct ?? 0,
              mismatched: scores[i]?.mismatched ?? 0,
            }
            await sink(basis.templateId).put([[key(basis), observation]])
            observations.set(basis.versionId, observation)
          }
          if (hash === null) skipped++
          else imported++
        }
      } catch (cause) {
        failed++
        error = cause instanceof Error ? cause.message : String(cause)
      }

      for (const basis of active) {
        const observation = observations.get(basis.versionId)
        const run = runOf(basis)
        run.correct[step.index] = (run.correct[step.index] ?? 0) + (observation?.correct ?? 0)
        run.mismatched[step.index] =
          (run.mismatched[step.index] ?? 0) + (observation?.mismatched ?? 0)
        const chunk = basis.chunks.some((entry) => entry.tileX === tile.x && entry.tileY === tile.y)
        run.incomplete[step.index] =
          run.incomplete[step.index] === true || (chunk && observation?.hash == null)
        // Every tile of this template has now seen the snapshot, so its sample is complete.
        if (last.get(basis.versionId) !== tileKey(tile)) continue
        const unknown = run.incomplete[step.index] === true
        await sink(basis.templateId).put([
          [
            `sample:${basis.versionId}:${suffix(snapshot.id)}`,
            {
              at: snapshot.at,
              snapshotId: snapshot.id,
              correct: unknown ? null : (run.correct[step.index] ?? 0),
              mismatched: unknown ? null : (run.mismatched[step.index] ?? 0),
              total: basis.total,
            } satisfies ArchiveProgressSample,
          ],
        ])
      }
      reached = Math.max(reached ?? snapshot.at, snapshot.at)
      summary = {
        ...summary,
        completed: summary.completed + 1,
        imported: summary.imported + imported,
        skipped: summary.skipped + skipped,
        failed: summary.failed + failed,
        error,
      }
      break
    }

    if (summary.completed === summary.total)
      summary = {
        ...summary,
        status: summary.failed > 0 ? 'failed' : 'completed',
        // Snapshots past every template's native start were passed over, not imported.
        to: reached ?? summary.from,
      }
    if (held.snapshots !== undefined) await this.storage.put<StoredPlan>('plan', plan)
    await this.storage.put<StoredJob>('job', { summary, runs, reached })
    if (summary.status === 'running')
      await this.storage.setAlarm(this.now() + NEXT_STEP_DELAY_MILLISECONDS)
  }
}
