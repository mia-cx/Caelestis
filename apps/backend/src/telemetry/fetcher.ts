import {
  millis,
  planTimelapseTiles,
  type Seconds,
  seconds,
  sha256Hex,
  type TileCoord,
  type TileKey,
  tileKey,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import type { BlobStore, CounterStore, SqlStore } from '../ports/index.js'
import {
  type BackendRuntime,
  createBackendRuntime,
  makeBackendContext,
} from '../runtime/backend-runtime.js'
import {
  bestEffort,
  DirectStatusReadModel,
  type StatusReadModelPort,
} from '../status-read-model/port.js'
import {
  ALARM_FOLLOW_UP_RETRY_MILLISECONDS,
  ALARM_SCAN_INTERVAL_SECONDS,
  ALARM_SCAN_JITTER_SECONDS,
} from './alarm-policy.js'
import type { AlarmProbe } from './alarms/store.js'
import {
  createDerivedArtifactWriter,
  type DerivedArtifactWriter,
} from './derived-artifact-writer.js'
import {
  createIngestSinks,
  flushIngestSinks,
  type IngestSinks,
  MAX_CANVAS_TILE_BYTES,
  type MirrorOutcome,
  mirrorTile,
} from './ingest.js'

/**
 * The server's own tile mirror, run every `ALARM_SCAN_INTERVAL_SECONDS`.
 *
 * Userscript reports keep template tiles fresh while anyone is painting; this keeps them from
 * going dark when nobody is, and collects enough surroundings to centre each template in a 16:9
 * timelapse. Context tiles are server-owned and never gate on template coverage.
 *
 * Deduplication happens at three layers, which is why overlapping templates cost nothing extra:
 * the complete plan is a set keyed by tile (two templates sharing a tile fetch it once), the blob
 * store is content-addressed (identical bytes from anywhere store once), and a tile whose hash
 * matches the latest accepted observation is skipped without writing history at all.
 */
export const FETCHER_DISPLAY_NAME = 'Caelestis tile fetcher'

/** The fetcher's synthetic reporter account. No paint event ever carries it, so no leaderboard row. */
export const FETCHER_USER_ID = 0

/**
 * Subrequest budget per run: each tile is one upstream fetch plus a handful of storage calls, and
 * Workers cap subrequests per invocation. Template tiles stay first for alarm freshness. Within
 * template and context work, the oldest observation goes first so deferred tiles rotate.
 */
const MAX_FETCH_TILES_PER_RUN = 100
const MAX_ALARM_PROBES_PER_RUN = 25

export interface FetcherStores {
  readonly blobs: BlobStore
  readonly sql: SqlStore
  readonly counters: CounterStore
  readonly statusReadModel?: StatusReadModelPort
}

const WPLACE_TILE_USER_AGENT = 'Caelestis-Tile-Fetcher/1.0'

export interface FetchReport {
  readonly fetched: number
  readonly unchanged: number
  readonly failed: number
  /** Tiles left for the next run after the per-run budget was spent. */
  readonly deferred: number
  /** Whether at least one regression asked the watcher for a ten-minute probe. */
  readonly followUpScheduled: boolean
}

export interface AlarmFollowUpReport {
  readonly evaluated: number
  readonly failed: number
  /** Due probes that still need another bounded batch. */
  readonly pending: number
}

const compareAlarmTileFreshness = (
  left: { readonly tile: TileCoord; readonly observedAt: number | null },
  right: { readonly tile: TileCoord; readonly observedAt: number | null },
): number =>
  (left.observedAt ?? -1) - (right.observedAt ?? -1) ||
  left.tile.y - right.tile.y ||
  left.tile.x - right.tile.x

const wplaceTileUrl = (season: number, tile: TileCoord): string =>
  `https://backend.wplace.live/files/s${season}/tiles/${tile.x}/${tile.y}.png`

/** One fetcher job: its stores, clock, and the sinks its tiles share until the job ends. */
interface FetchRun {
  readonly runtime: BackendRuntime
  readonly statusReadModel: StatusReadModelPort
  readonly sinks: IngestSinks
  /** The job's own writer, so the job can wait for its masks; it has no reply to keep fast. */
  readonly writer: DerivedArtifactWriter
  readonly fetchImpl: typeof fetch
  readonly now: Seconds
  readonly tokenHash: string
}

const startRun = async (
  ports: FetcherStores,
  options: { readonly now?: Seconds; readonly fetchImpl?: typeof fetch },
): Promise<FetchRun> => {
  const statusReadModel = ports.statusReadModel ?? new DirectStatusReadModel(ports.sql)
  const writer = createDerivedArtifactWriter()
  return {
    runtime: createBackendRuntime(
      makeBackendContext(ports.blobs, ports.sql, ports.counters, statusReadModel),
    ),
    statusReadModel,
    sinks: createIngestSinks({ blobs: ports.blobs, statusReadModel }, writer),
    writer,
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? seconds(Math.floor(Date.now() / 1_000)),
    tokenHash: await sha256Hex(new TextEncoder().encode('caelestis-tile-fetcher')),
  }
}

const finishRun = async (run: FetchRun): Promise<void> => {
  try {
    await flushIngestSinks(run.sinks)
  } finally {
    await run.writer.drain()
  }
}

/** Fetch one tile from Wplace, or null when Wplace served nothing usable. */
const downloadTile = async (
  run: FetchRun,
  season: number,
  tile: TileCoord,
): Promise<Uint8Array | null> => {
  const response = await run.fetchImpl(wplaceTileUrl(season, tile), {
    headers: { 'user-agent': WPLACE_TILE_USER_AGENT },
  })
  if (!response.ok) return null
  const bytes = new Uint8Array(await response.arrayBuffer())
  return bytes.byteLength === 0 || bytes.byteLength > MAX_CANVAS_TILE_BYTES ? null : bytes
}

/** Record downloaded bytes; a failure to record them throws. */
const mirror = async (
  run: FetchRun,
  season: number,
  tile: TileCoord,
  bytes: Uint8Array,
  latestHash: string | null,
  recordHistory?: boolean,
): Promise<MirrorOutcome> =>
  run.runtime.run(
    mirrorTile(
      {
        wplaceUserId: FETCHER_USER_ID,
        displayName: FETCHER_DISPLAY_NAME,
        tokenHash: run.tokenHash,
        season,
        tile,
        hash: await sha256Hex(bytes),
        observedAt: run.now,
        includeUnpublished: true,
        ...(recordHistory === undefined ? {} : { recordHistory }),
      },
      bytes,
      { latestHash, sinks: run.sinks },
    ),
  )

export const fetchCanvasTiles = async (
  ports: FetcherStores,
  options: {
    readonly season: number
    readonly now?: Seconds
    readonly fetchImpl?: typeof fetch
    readonly alarmIdFactory?: () => string
  },
): Promise<FetchReport> => {
  const run = await startRun(ports, options)
  const { now } = run
  const alarmIdFactory = options.alarmIdFactory ?? uuidV7
  const { season } = options

  // Plan the whole run before making an upstream request. Unpublished templates are included too:
  // an admin's draft deserves the same timelapse the published version will show.
  const templates = await ports.sql.listManifestTemplates(
    { season, surface: WORLD_TEMPLATE_SURFACE },
    true,
  )
  const alarmTiles = await ports.sql.listAlarmTiles(season)
  const templateTiles = new Map<TileKey, { tile: TileCoord; observedAt: number | null }>()
  for (const row of alarmTiles) {
    const tile = { x: row.tileX, y: row.tileY }
    const key = tileKey(tile)
    const held = templateTiles.get(key)
    if (held === undefined || (row.observedAt ?? -1) < (held.observedAt ?? -1)) {
      templateTiles.set(key, { tile, observedAt: row.observedAt })
    }
  }
  const plannedTiles = new Map(
    planTimelapseTiles(templates.map(({ bbox }) => bbox)).map(
      (tile) => [tileKey(tile), tile] as const,
    ),
  )
  for (const [key, { tile }] of templateTiles) plannedTiles.set(key, tile)
  const historyTiles = new Set(
    planTimelapseTiles(templates.filter(({ finished }) => !finished).map(({ bbox }) => bbox)).map(
      tileKey,
    ),
  )
  const latestTiles = new Map(
    (await ports.sql.listLatestTiles(season)).map(
      (latest) => [tileKey(latest.tile), latest] as const,
    ),
  )

  const work = [...plannedTiles].map(([key, tile]) => {
    const template = templateTiles.get(key)
    const latest = latestTiles.get(key) ?? null
    return {
      tile,
      template: template !== undefined,
      recordHistory: historyTiles.has(key),
      latest,
      observedAt: template?.observedAt ?? latest?.observedAt ?? null,
    }
  })
  work.sort(
    (left, right) =>
      Number(right.template) - Number(left.template) ||
      (left.observedAt ?? -1) - (right.observedAt ?? -1) ||
      left.tile.y - right.tile.y ||
      left.tile.x - right.tile.x,
  )

  let fetched = 0
  let unchanged = 0
  let failed = 0
  const budgeted = work.slice(0, MAX_FETCH_TILES_PER_RUN)
  const attemptedTemplateTiles = new Set<string>(
    budgeted.filter(({ template }) => template).map(({ tile }) => tileKey(tile)),
  )
  const serverRefreshedTemplateTiles = new Set<string>()
  try {
    for (const { tile, template, recordHistory, latest } of budgeted) {
      try {
        const bytes = await downloadTile(run, season, tile)
        if (bytes === null) {
          failed++
          continue
        }
        const outcome = await mirror(run, season, tile, bytes, latest?.hash ?? null, recordHistory)
        if (outcome === 'unchanged') unchanged++
        else fetched++
        if (template) serverRefreshedTemplateTiles.add(tileKey(tile))
      } catch (error) {
        // One unreachable tile must not starve the rest of the run.
        console.error(`tile mirror failed for ${season}:${tileKey(tile)}`, error)
        failed++
      }
    }
  } finally {
    await finishRun(run)
  }

  const refreshedAlarmTiles = await ports.sql.listAlarmTiles(season)
  const requiredTiles = new Map<
    string,
    Array<{ readonly key: string; readonly observedAt: number | null }>
  >()
  for (const row of refreshedAlarmTiles) {
    const requirement = {
      key: tileKey({ x: row.tileX, y: row.tileY }),
      observedAt: row.observedAt,
    }
    const held = requiredTiles.get(row.templateId)
    if (held === undefined) requiredTiles.set(row.templateId, [requirement])
    else held.push(requirement)
  }
  const alarmSnapshot = await ports.sql.readAlarmStatusSnapshot(season)
  const statusesById = new Map(alarmSnapshot.templates.map((status) => [status.templateId, status]))
  const scanCycleBatches = Math.max(1, Math.ceil(templateTiles.size / MAX_FETCH_TILES_PER_RUN))
  const freshnessCutoff =
    (now - scanCycleBatches * ALARM_SCAN_INTERVAL_SECONDS - ALARM_SCAN_JITTER_SECONDS) * 1_000
  let followUpScheduled = false
  let alarmChanged = false
  try {
    for (const template of templates) {
      const required = requiredTiles.get(template.id) ?? []
      const status = statusesById.get(template.id)
      if (
        required.length === 0 ||
        !required.every(
          ({ key, observedAt }) =>
            observedAt !== null &&
            observedAt >= freshnessCutoff &&
            (!attemptedTemplateTiles.has(key) || serverRefreshedTemplateTiles.has(key)),
        ) ||
        status === undefined ||
        status.total !== template.totalPixels ||
        status.correct + status.wrong + status.blank !== status.total
      ) {
        continue
      }
      const result = await ports.sql.evaluateTemplateAlarm(
        {
          templateId: template.id,
          versionId: template.versionId,
          total: status.total,
          correct: status.correct,
          observedAt: millis(now * 1_000),
          observationRevision: alarmSnapshot.revision,
        },
        { kind: 'scan' },
        alarmIdFactory(),
      )
      alarmChanged ||= result.alarmChanged
      followUpScheduled ||= result.scheduleFollowUp
    }
  } finally {
    // A scan that moves no alarm owes subscribers nothing; a changed alarm covers its follow-up.
    // Each evaluation commits on its own, so a later failure still owes the earlier changes.
    if (alarmChanged) await bestEffort(() => run.statusReadModel.notifyAlarmChange(season))
  }

  return {
    fetched,
    unchanged,
    failed,
    deferred: work.length - budgeted.length,
    followUpScheduled,
  }
}

/** Refetch only the templates whose six-hour scan opened a regression episode. */
export const fetchAlarmFollowUps = async (
  ports: FetcherStores,
  probes: readonly AlarmProbe[],
  options: {
    readonly now?: Seconds
    readonly fetchImpl?: typeof fetch
  } = {},
): Promise<AlarmFollowUpReport> => {
  const run = await startRun(ports, options)
  const { now } = run
  let evaluated = 0
  let failed = 0
  const changedSeasons = new Set<number>()
  const selectedProbes = probes.slice(0, MAX_ALARM_PROBES_PER_RUN)
  let pending = probes.length - selectedProbes.length
  let remaining = MAX_FETCH_TILES_PER_RUN

  try {
    for (const probe of selectedProbes) {
      const template = (
        await ports.sql.listManifestTemplates(
          { season: probe.season, surface: WORLD_TEMPLATE_SURFACE },
          true,
        )
      ).find(
        (candidate) => candidate.id === probe.templateId && candidate.versionId === probe.versionId,
      )
      let tiles = (await ports.sql.listAlarmTiles(probe.season)).filter(
        (row) => row.templateId === probe.templateId && row.versionId === probe.versionId,
      )
      if (template === undefined || tiles.length === 0) {
        await ports.sql.clearAlarmProbe(probe.templateId, probe.alarmId, probe.dueAt)
        failed++
        continue
      }
      const staleTiles = tiles
        .filter((row) => row.observedAt === null || row.observedAt < probe.dueAt)
        .map((row) => ({
          ...row,
          tile: { x: row.tileX, y: row.tileY },
        }))
        .sort(compareAlarmTileFreshness)
      if (staleTiles.length > 0 && remaining === 0) {
        pending++
        continue
      }
      const batch = staleTiles.slice(0, remaining)

      let complete = true
      for (const { tile } of batch) {
        remaining--
        try {
          const bytes = await downloadTile(run, probe.season, tile)
          if (bytes === null) {
            complete = false
            break
          }
          const latest = await ports.sql.readLatestTile(probe.season, tile)
          await mirror(run, probe.season, tile, bytes, latest?.hash ?? null)
        } catch (error) {
          console.error(`alarm probe tile fetch failed for ${probe.season}:${tileKey(tile)}`, error)
          complete = false
          break
        }
      }

      if (!complete) {
        await ports.sql.deferAlarmProbe(
          probe.templateId,
          probe.alarmId,
          probe.dueAt,
          millis(now * 1_000 + ALARM_FOLLOW_UP_RETRY_MILLISECONDS),
        )
        failed++
        pending++
        continue
      }
      tiles = (await ports.sql.listAlarmTiles(probe.season)).filter(
        (row) => row.templateId === probe.templateId && row.versionId === probe.versionId,
      )
      const alarmSnapshot = await ports.sql.readAlarmStatusSnapshot(probe.season)
      const status = alarmSnapshot.templates.find(
        (candidate) => candidate.templateId === probe.templateId,
      )
      if (
        status === undefined ||
        status.total !== template.totalPixels ||
        status.correct + status.wrong + status.blank !== status.total ||
        !tiles.every((row) => row.observedAt !== null && row.observedAt >= probe.dueAt)
      ) {
        if (batch.length === 0) {
          await ports.sql.deferAlarmProbe(
            probe.templateId,
            probe.alarmId,
            probe.dueAt,
            millis(now * 1_000 + ALARM_FOLLOW_UP_RETRY_MILLISECONDS),
          )
          failed++
        }
        pending++
        continue
      }
      const result = await ports.sql.evaluateTemplateAlarm(
        {
          templateId: probe.templateId,
          versionId: probe.versionId,
          total: status.total,
          correct: status.correct,
          observedAt: millis(now * 1_000),
          observationRevision: alarmSnapshot.revision,
        },
        {
          kind: 'follow-up',
          alarmId: probe.alarmId,
          pixelsLost: probe.pixelsLost,
          dueAt: probe.dueAt,
        },
        'unused',
      )
      evaluated++
      if (result.alarmChanged) changedSeasons.add(probe.season)
    }
  } finally {
    try {
      await finishRun(run)
    } finally {
      // Each evaluation commits on its own, so a later failure still owes the earlier changes.
      for (const season of changedSeasons)
        await bestEffort(() => run.statusReadModel.notifyAlarmChange(season))
    }
  }

  return { evaluated, failed, pending }
}
