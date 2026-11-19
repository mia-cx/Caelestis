import {
  type AlarmsResponse,
  type CanvasTilesResponse,
  type ContributionsResponse,
  type HistoryResponse,
  type LeaderboardResponse,
  type PainterHistoryResponse,
  type PainterTotalsResponse,
  planTimelapseTiles,
  type Seconds,
  type ServerInfo,
  type StatusResponse,
  seconds,
  sha256Hex,
  type TileCoord,
  type TileHistoryFrame,
  type TileHistoryResponse,
  type TileKey,
  tileKey,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { Effect } from 'effect'
import { readManifestProjection } from '../manifest/use-cases.js'
import { recordCacheOutcome } from '../metrics/request-metrics.js'
import type { BlobStore } from '../ports/index.js'
import {
  BlobStoreService,
  SqlStoreService,
  StatusReadModelService,
} from '../runtime/backend-runtime.js'
import { type StorageError, storage } from '../runtime/errors.js'
import type { TemplateStore } from '../templates/store.js'
import type { TileBlobStore } from './blobs/store.js'
import { classificationKey, classifyTarget, readDecodedCanvas } from './classification.js'
import { type DecayEdge, foldCutoff, targetWindowStart } from './decay.js'
import {
  logArtifactFailure,
  putMismatchArtifact,
  readMismatchArtifact,
} from './derived-artifacts.js'
import { LADDER_RESOLUTIONS, TELEMETRY_DECAY_EDGES } from './history/ladder.js'
import { TILE_HISTORY_DECAY_EDGES, TILE_HISTORY_RESOLUTIONS } from './tiles/ladder.js'
import type { TileStore } from './tiles/store.js'

interface HistoryTier {
  readonly resolution: number
  /** The edge that folds this tier into the next. Omitted for the final, permanent tier. */
  readonly edge?: DecayEdge
  /** Raw tile observations are irregular; one minute is a conservative density estimate. */
  readonly estimatedStep?: number
}

const historyTiers = (
  resolutions: readonly number[],
  edges: readonly DecayEdge[],
): readonly HistoryTier[] =>
  resolutions.map((resolution) => {
    const edge = edges.find((candidate) => candidate.source === resolution)
    return {
      resolution,
      ...(edge === undefined ? {} : { edge }),
      ...(resolution === 0 ? { estimatedStep: 60 } : {}),
    }
  })

const TELEMETRY_HISTORY_TIERS = historyTiers(LADDER_RESOLUTIONS, TELEMETRY_DECAY_EDGES)
const TILE_HISTORY_TIERS = historyTiers(TILE_HISTORY_RESOLUTIONS, TILE_HISTORY_DECAY_EDGES)

const TARGET_HISTORY_POINTS = 200

export interface HistoryRange {
  readonly fromSeconds: Seconds
  readonly toSeconds: Seconds
}

/** Pick one tier that covers the whole range without making the client know the ladder. */
const selectHistoryResolution = (
  tiers: readonly HistoryTier[],
  range: HistoryRange,
  now: Seconds,
): number => {
  const permanent = tiers.at(-1)
  if (permanent === undefined) throw new Error('history tier ladder must not be empty')
  const eligible = tiers.filter(
    (tier) => tier.edge === undefined || range.fromSeconds >= foldCutoff(tier.edge, now),
  )
  const covering = eligible.length === 0 ? [permanent] : eligible
  const width = range.toSeconds - range.fromSeconds
  const selected =
    covering
      .filter((tier) => width / (tier.estimatedStep ?? tier.resolution) >= TARGET_HISTORY_POINTS)
      .at(-1) ?? covering[0]
  if (selected === undefined) throw new Error('history tier ladder must not be empty')
  return selected.resolution
}

const nowSeconds = (): Seconds => seconds(Math.floor(Date.now() / 1_000))

export const selectTileHistoryResolution = (range: HistoryRange): number =>
  selectHistoryResolution(TILE_HISTORY_TIERS, range, nowSeconds())

const selectTelemetryResolution = (
  range: HistoryRange,
  maxResolution: number | undefined,
  now: Seconds,
): number =>
  selectHistoryResolution(
    maxResolution === undefined
      ? TELEMETRY_HISTORY_TIERS
      : TELEMETRY_HISTORY_TIERS.filter((tier) => tier.resolution <= maxResolution),
    range,
    now,
  )

const telemetryCoverageStart = (resolution: number, range: HistoryRange, now: Seconds): Seconds => {
  const edge = TELEMETRY_HISTORY_TIERS.find((tier) => tier.resolution === resolution)?.edge
  if (edge === undefined) return range.fromSeconds

  // Folding waits until a complete target bucket crosses the retention cutoff. The target bucket
  // containing that cutoff is therefore the first interval with guaranteed source-tier coverage.
  const retainedStart = targetWindowStart(foldCutoff(edge, now), edge)
  const requestedStart = Math.max(range.fromSeconds, retainedStart)
  return seconds(Math.ceil(requestedStart / resolution) * resolution)
}

interface LadderBucket {
  readonly resolution: number
  readonly bucketStart: Seconds
  readonly placed: number
  readonly correct: number
  readonly repairs: number
}

/**
 * Sum stored buckets onto one resolution's grid. Buckets of different tiers can overlap the same
 * target bucket; the coarsest wins and finer buckets it covers are dropped, so nothing counts
 * twice. `groupOf` names the series a bucket belongs to.
 */
const coalesceBuckets = <Bucket extends LadderBucket>(
  buckets: readonly Bucket[],
  resolution: number,
  range: HistoryRange,
  groupOf: (bucket: Bucket) => string,
) => {
  const groups = new Map<string, { first: Bucket; bucketStart: Seconds; candidates: Bucket[] }>()
  for (const bucket of buckets) {
    const bucketStart = seconds(Math.floor(bucket.bucketStart / resolution) * resolution)
    if (bucketStart < range.fromSeconds || bucketStart >= range.toSeconds) continue
    const key = `${groupOf(bucket)}\u0000${bucketStart}`
    const held = groups.get(key)
    if (held === undefined) groups.set(key, { first: bucket, bucketStart, candidates: [bucket] })
    else held.candidates.push(bucket)
  }
  return [...groups.values()].map(({ first, bucketStart, candidates }) => {
    const selected: Bucket[] = []
    for (const candidate of [...candidates].sort(
      (left, right) => right.resolution - left.resolution || left.bucketStart - right.bucketStart,
    )) {
      const end = candidate.bucketStart + candidate.resolution
      if (
        selected.some(
          (held) =>
            candidate.bucketStart < held.bucketStart + held.resolution && end > held.bucketStart,
        )
      )
        continue
      selected.push(candidate)
    }
    return {
      first,
      resolution,
      bucketStart,
      placed: selected.reduce((total, bucket) => total + bucket.placed, 0),
      correct: selected.reduce((total, bucket) => total + bucket.correct, 0),
      repairs: selected.reduce((total, bucket) => total + bucket.repairs, 0),
    }
  })
}

const compareIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

/** Keep each tier's observations unless a finer tier covers the same bucket. */
const mergeTileHistory = (
  tiers: readonly { readonly resolution: number; readonly frames: readonly TileHistoryFrame[] }[],
): readonly TileHistoryFrame[] => {
  const covered = new Map(
    TILE_HISTORY_RESOLUTIONS.map((resolution) => [resolution, new Set<number>()]),
  )
  const frames: TileHistoryFrame[] = []
  // Callers read tiers in ascending resolution order. Raw observations therefore win even when
  // a frozen template or a late report preserves them inside an already-folded bucket.
  for (const tier of tiers) {
    for (const frame of tier.frames) {
      if (covered.get(tier.resolution)?.has(frame.bucketStart)) continue
      frames.push(frame)
      for (const [resolution, starts] of covered) {
        if (resolution > tier.resolution) {
          starts.add(Math.floor(frame.bucketStart / resolution) * resolution)
        }
      }
    }
  }
  return frames.sort((left, right) => left.bucketStart - right.bucketStart)
}

/**
 * Bucket rows carry no publication state. Resolve ids through the same visibility gate as the
 * manifest so a stale unpublished id looks absent instead of leaking that it still exists.
 */
const visibleTemplateIds = (
  sql: TemplateStore,
  ids: readonly string[],
  includeUnpublished: boolean,
) =>
  includeUnpublished
    ? Effect.succeed(ids)
    : storage('filterPublishedTemplateIds', () => sql.filterPublishedTemplateIds(ids))

export const readAlarms = (
  season: number,
  includeUnpublished: boolean,
): Effect.Effect<AlarmsResponse, StorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const alarms = yield* storage('readActiveAlarms', () =>
      sql.readActiveAlarms(season, includeUnpublished),
    )
    const version = yield* Effect.promise(() =>
      sha256Hex(new TextEncoder().encode(JSON.stringify(alarms))),
    )
    return { version, alarms }
  })

/** A status response and, for the cached current season, the entity tag value naming its content. */
export interface StatusRead {
  readonly response: StatusResponse
  readonly version: string | null
}

export const readStatus = (
  season: number,
  includeUnpublished: boolean,
  cacheable: boolean,
): Effect.Effect<StatusRead, StorageError, SqlStoreService | StatusReadModelService> =>
  Effect.gen(function* () {
    if (!cacheable) {
      const sql = yield* SqlStoreService
      const templates = yield* storage('readTemplateStatuses', () =>
        sql.readTemplateStatuses(season, includeUnpublished),
      )
      return { response: { templates }, version: null }
    }
    const scope = includeUnpublished ? 'admin' : 'public'
    const readModel = yield* StatusReadModelService
    const read = yield* storage('reconcileStatusSnapshot', () =>
      readModel.reconcileSnapshot(season, scope),
    )
    recordCacheOutcome(read.cacheOutcome)
    return { response: read.snapshot, version: `status.${season}.${scope}.${read.validator}` }
  })

export const readHistory = (input: {
  readonly templateIds: readonly string[]
  readonly range: HistoryRange
  readonly legacyResolution?: number | undefined
  readonly maxResolution?: number | undefined
  readonly includeUnpublished: boolean
}): Effect.Effect<HistoryResponse, StorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const readAt = nowSeconds()
    const resolution =
      input.legacyResolution ?? selectTelemetryResolution(input.range, input.maxResolution, readAt)
    const visibleIds = yield* visibleTemplateIds(sql, input.templateIds, input.includeUnpublished)
    const buckets =
      visibleIds.length === 0
        ? []
        : yield* storage('readBuckets', () =>
            sql.readBuckets({
              templateIds: visibleIds,
              resolution:
                input.legacyResolution === undefined
                  ? LADDER_RESOLUTIONS.filter((tier) => tier <= resolution)
                  : resolution,
              ...input.range,
            }),
          )
    return {
      ...(input.maxResolution === undefined
        ? {}
        : {
            resolution,
            coverageStart: telemetryCoverageStart(resolution, input.range, readAt),
          }),
      buckets:
        input.legacyResolution === undefined
          ? coalesceBuckets(buckets, resolution, input.range, (bucket) => bucket.templateId)
              .map(({ first, ...bucket }) => ({ templateId: first.templateId, ...bucket }))
              .sort(
                (left, right) =>
                  compareIds(left.templateId, right.templateId) ||
                  left.bucketStart - right.bucketStart,
              )
          : buckets,
    }
  })

/**
 * `readHistory` per painter. Same tier selection, coverage boundary and publish gate, grouped by
 * template and painter, so a painter's line lands on the template's grid exactly. The rows come
 * from `painter_telemetry_buckets`, which only ever holds what paint reports said, so a painter
 * whose client does not report is simply absent.
 */
export const readPainterHistory = (input: {
  readonly templateIds: readonly string[]
  /** The painters to draw; the read is bounded by this list, not by the scope's age. */
  readonly wplaceUserIds: readonly number[]
  readonly range: HistoryRange
  readonly maxResolution?: number | undefined
  readonly includeUnpublished: boolean
}): Effect.Effect<PainterHistoryResponse, StorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const readAt = nowSeconds()
    const resolution = selectTelemetryResolution(input.range, input.maxResolution, readAt)
    const visibleIds = yield* visibleTemplateIds(sql, input.templateIds, input.includeUnpublished)
    const buckets =
      visibleIds.length === 0 || input.wplaceUserIds.length === 0
        ? []
        : yield* storage('readPainterBuckets', () =>
            sql.readPainterBuckets({
              templateIds: visibleIds,
              wplaceUserIds: input.wplaceUserIds,
              resolution: LADDER_RESOLUTIONS.filter((tier) => tier <= resolution),
              ...input.range,
            }),
          )
    const names = yield* storage('readPainterNames', () =>
      sql.readPainterNames([...new Set(buckets.map((bucket) => bucket.wplaceUserId))]),
    )
    // The ladder says how far back a tier is kept; the collection marker says how far back this
    // deployment kept painters at all. Coverage is the later of the two, so the time before the
    // table existed stays unavailable instead of reading as silence.
    const collectionStart = yield* storage('readPainterCollectionStart', () =>
      sql.readPainterCollectionStart(),
    )
    const coverageStart = seconds(
      Math.max(
        telemetryCoverageStart(resolution, input.range, readAt),
        collectionStart === null ? readAt : Math.ceil(collectionStart / resolution) * resolution,
      ),
    )
    const folded = coalesceBuckets(
      buckets,
      resolution,
      input.range,
      (bucket) => `${bucket.templateId}:${bucket.wplaceUserId}`,
    ).map(({ first, ...bucket }) => ({
      templateId: first.templateId,
      wplaceUserId: first.wplaceUserId,
      displayName: names.get(first.wplaceUserId) ?? String(first.wplaceUserId),
      ...bucket,
    }))
    return {
      ...(input.maxResolution === undefined ? {} : { resolution, coverageStart }),
      buckets: folded.sort(
        (left, right) =>
          compareIds(left.templateId, right.templateId) ||
          left.wplaceUserId - right.wplaceUserId ||
          left.bucketStart - right.bucketStart,
      ),
    }
  })

/**
 * Who painted in a range and how much, leading first: the list a dashboard picks painters from.
 * Summed in the database at the tier `/painter-history` would choose for the range, so a scope's
 * lifetime costs one bounded list per read rather than every retained row.
 */
export const readPainterTotals = (input: {
  readonly templateIds: readonly string[]
  readonly range: HistoryRange
  readonly limit: number
  readonly includeUnpublished: boolean
}): Effect.Effect<PainterTotalsResponse, StorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const visibleIds = yield* visibleTemplateIds(sql, input.templateIds, input.includeUnpublished)
    const totals =
      visibleIds.length === 0
        ? []
        : yield* storage('readPainterTotals', () =>
            sql.readPainterTotals(
              { templateIds: visibleIds, resolution: LADDER_RESOLUTIONS, ...input.range },
              input.limit,
            ),
          )
    const names = yield* storage('readPainterNames', () =>
      sql.readPainterNames(totals.map((total) => total.wplaceUserId)),
    )
    return {
      painters: totals.map((total) => ({
        ...total,
        displayName: names.get(total.wplaceUserId) ?? String(total.wplaceUserId),
      })),
    }
  })

export const readContributions = (input: {
  readonly templateIds: readonly string[]
  readonly range: HistoryRange
  readonly includeUnpublished: boolean
}): Effect.Effect<ContributionsResponse, StorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    // The store already reduces reporter rows per painter-day. Returning those rows directly avoids
    // crediting one day once per reporting client.
    const days = yield* storage('readContributions', () =>
      sql.readContributions({
        templateIds: input.templateIds,
        ...input.range,
        includeUnpublished: input.includeUnpublished,
      }),
    )
    return { days }
  })

export const readLeaderboard = (input: {
  readonly season: number
  readonly templateIds?: readonly string[] | undefined
  readonly from?: Seconds | undefined
  readonly to?: Seconds | undefined
  readonly limit: number
  readonly includeUnpublished: boolean
}): Effect.Effect<LeaderboardResponse, StorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    // MAX-then-SUM: the store reduces each painter-day across reporters before it sums days.
    const entries = yield* storage('readLeaderboard', () =>
      sql.readLeaderboard(
        {
          season: input.season,
          ...(input.templateIds === undefined ? {} : { templateIds: input.templateIds }),
          ...(input.from === undefined ? {} : { fromSeconds: input.from }),
          ...(input.to === undefined ? {} : { toSeconds: input.to }),
          includeUnpublished: input.includeUnpublished,
        },
        input.limit,
      ),
    )
    return { entries }
  })

/**
 * The canvas tiles a caller below admin may see: the timelapse capture of every published template.
 * The fetcher captures drafts too, and their tiles alone would show where a draft is being drawn.
 */
const publishedCanvasTiles = async (sql: TemplateStore, season: number): Promise<Set<TileKey>> =>
  new Set(
    planTimelapseTiles(
      (await sql.listManifestTemplates({ season, surface: WORLD_TEMPLATE_SURFACE }, false)).map(
        ({ bbox }) => bbox,
      ),
    ).map(tileKey),
  )

export const readCanvas = (
  season: number,
  includeUnpublished: boolean,
): Effect.Effect<CanvasTilesResponse, StorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const [latest, visible] = yield* storage('listLatestTiles', () =>
      Promise.all([
        sql.listLatestTiles(season),
        includeUnpublished ? null : publishedCanvasTiles(sql, season),
      ]),
    )
    const held =
      visible === null ? latest : latest.filter((tile) => visible.has(tileKey(tile.tile)))
    return {
      tiles: held.map((tile) => ({
        tile: tileKey(tile.tile),
        hash: tile.hash,
        observedAt: tile.observedAt,
      })),
    }
  })

/** Templates read one by one to confirm a cached tile before one season listing replaces them. */
const MAX_OWNER_READS = 8

/** A published template version whose timelapse capture covers a tile. Versions never change. */
interface TileOwner {
  readonly templateId: string
  readonly versionId: string
}

/**
 * Which published template versions' timelapse captures cover each canvas tile, planned from the
 * current season's public world manifest and kept for that manifest version. Each read revalidates
 * the version with If-None-Match against the manifest read model, so publishing shows up as soon as
 * the manifest does. Keyed by content hash, so one entry serves every backend that shares it.
 * Module scope, because concurrent requests in one Worker isolate share nothing else.
 */
let currentSeasonTiles: {
  readonly season: number
  readonly version: string
  readonly owners: ReadonlyMap<TileKey, readonly TileOwner[]>
} | null = null

/**
 * Whether a reader may see a current-season tile. The manifest cache may only hide a tile: a
 * failed invalidation can leave a template cached after it was unpublished or moved, so a tile it
 * shows is confirmed against the database. One of its templates must still be published on this
 * season's world surface at the very version, and so the very bounds, that covered the tile.
 */
const currentSeasonTileVisible = (
  server: ServerInfo,
  season: number,
  tile: TileKey,
): Effect.Effect<boolean, StorageError, SqlStoreService | StatusReadModelService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const held = currentSeasonTiles?.season === season ? currentSeasonTiles : null
    const projection = yield* readManifestProjection({
      server,
      season,
      surface: WORLD_TEMPLATE_SURFACE,
      includeUnpublished: false,
      ifNoneMatch: held === null ? [] : [`"${held.version}"`],
      cacheable: true,
    })
    let owners = held?.owners
    if (!projection.notModified) {
      const planned = new Map<TileKey, TileOwner[]>()
      for (const template of projection.manifest.templates) {
        const owner = { templateId: template.id, versionId: template.version }
        for (const key of planTimelapseTiles([template.bbox]).map(tileKey)) {
          const held = planned.get(key)
          if (held === undefined) planned.set(key, [owner])
          else held.push(owner)
        }
      }
      currentSeasonTiles = { season, version: projection.version, owners: planned }
      owners = planned
    }
    // Only the held version is ever offered, so without one a match cannot happen; hide the tile.
    // A fresh cache confirms on the first read. Past a few misses, one listing of the season's
    // published templates answers for every owner, so a dense tile stays within D1's query budget.
    const candidates = owners?.get(tile) ?? []
    for (const { templateId, versionId } of candidates.slice(0, MAX_OWNER_READS)) {
      const record = yield* storage('readTemplate', () => sql.readTemplate(templateId))
      if (
        record?.published === true &&
        record.currentVersionId === versionId &&
        record.season === season &&
        record.surface.kind === WORLD_TEMPLATE_SURFACE.kind
      )
        return true
    }
    if (candidates.length <= MAX_OWNER_READS) return false
    const published = yield* storage('listManifestTemplates', () =>
      sql.listManifestTemplates({ season, surface: WORLD_TEMPLATE_SURFACE }, false),
    )
    const current = new Set(published.map(({ id, versionId }) => `${id}:${versionId}`))
    return candidates.some(({ templateId, versionId }) => current.has(`${templateId}:${versionId}`))
  })

/** Return all retained detail by default; an explicit resolution reads only that legacy tier. */
export const readTileHistory = (input: {
  readonly season: number
  readonly tile: TileCoord
  readonly range: HistoryRange
  readonly legacyResolution?: number | undefined
  readonly includeUnpublished: boolean
  /** Present for the current season, whose visibility the manifest read model caches. */
  readonly server?: ServerInfo | undefined
}): Effect.Effect<TileHistoryResponse, StorageError, SqlStoreService | StatusReadModelService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    const resolution = input.legacyResolution
    const hidden = input.includeUnpublished
      ? false
      : input.server === undefined
        ? !(yield* storage('listManifestTemplates', () =>
            publishedCanvasTiles(sql, input.season),
          )).has(tileKey(input.tile))
        : !(yield* currentSeasonTileVisible(input.server, input.season, tileKey(input.tile)))
    // Indistinguishable from a tile nobody captured.
    if (hidden) return { ...(resolution === undefined ? {} : { resolution }), frames: [] }
    const resolutions = resolution === undefined ? TILE_HISTORY_RESOLUTIONS : [resolution]
    const tiers = yield* storage('readTileHistory', () =>
      Promise.all(
        resolutions.map(async (tier) => ({
          resolution: tier,
          frames: await sql.readTileHistory({
            season: input.season,
            tile: input.tile,
            resolution: tier,
            ...input.range,
          }),
        })),
      ),
    )
    return {
      ...(resolution === undefined ? {} : { resolution }),
      frames: resolution === undefined ? mergeTileHistory(tiers) : (tiers[0]?.frames ?? []),
    }
  })

export type MismatchMaskRead =
  | { readonly kind: 'found'; readonly bytes: Uint8Array; readonly hash: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unobserved' }

export interface MismatchMaskQuery {
  readonly season: number
  readonly templateId: string
  readonly versionId: string
  readonly tile: TileCoord
  readonly includeUnpublished: boolean
}

const readMismatchMaskPromise = async (
  ports: { readonly blobs: BlobStore; readonly sql: TileStore & TileBlobStore },
  query: MismatchMaskQuery,
): Promise<MismatchMaskRead> => {
  const targets = await ports.sql.listTelemetryTargets(
    query.season,
    query.tile,
    query.includeUnpublished,
  )
  const target = targets.find(
    (candidate) =>
      candidate.templateId === query.templateId && candidate.versionId === query.versionId,
  )
  if (target === undefined) return { kind: 'not-found' }
  const latest = await ports.sql.readLatestTile(query.season, query.tile)
  if (latest === null) return { kind: 'unobserved' }
  const key = classificationKey(target, latest.hash)
  const artifact = await readMismatchArtifact(ports.blobs, key)
  if (artifact !== null) return { kind: 'found', bytes: artifact, hash: await sha256Hex(artifact) }
  const canvas = await readDecodedCanvas(ports, latest.hash)
  if (canvas === null) return { kind: 'unobserved' }
  const classified = await classifyTarget(ports, target, canvas, latest.hash)
  if (classified === null) return { kind: 'unobserved' }
  await putMismatchArtifact(ports.blobs, key, classified.mask).catch(logArtifactFailure)
  return { kind: 'found', bytes: classified.mask, hash: await sha256Hex(classified.mask) }
}

/** The server-owned classification mask of the latest accepted canvas observation. */
export const readMismatchMask = (
  query: MismatchMaskQuery,
): Effect.Effect<MismatchMaskRead, StorageError, BlobStoreService | SqlStoreService> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    return yield* storage('readMismatchMask', () => readMismatchMaskPromise({ blobs, sql }, query))
  })
