import {
  millis,
  parseTileKey,
  type Seconds,
  seconds,
  sha256Hex,
  type TileCoord,
  tileKey,
} from '@caelestis/shared'
import { Effect, Result } from 'effect'
import { type IngestCommand, type IngestStage, ingestTimings } from '../metrics/ingest-timing.js'
import type { BlobStore } from '../ports/index.js'
import {
  BlobStoreService,
  SqlStoreService,
  StatusReadModelService,
} from '../runtime/backend-runtime.js'
import { fromPort, ValidationError } from '../runtime/errors.js'
import type {
  StatusProjectionChange,
  StatusProjectionMutation,
} from '../status-read-model/model.js'
import {
  bestEffort,
  type StatusProjectionPort,
  type StatusReadModelPort,
} from '../status-read-model/port.js'
import type { TileGenerationCacheRead } from '../status-read-model/tile-generation-cache.js'
import { evaluateAlarms } from './alarms/evaluate.js'
import type { AlarmStore } from './alarms/store.js'
import type { TileBlobStore } from './blobs/store.js'
import {
  classificationKey,
  classifyTarget,
  decodeCanvasBytes,
  InvalidTileError,
} from './classification.js'
import {
  createDerivedArtifactWriteBatch,
  type DerivedArtifactWriteBatch,
  type DerivedArtifactWriter,
  derivedArtifactWriter,
} from './derived-artifact-writer.js'
import type { HistoryStore } from './history/store.js'
import { foldTileHistoryThrottled } from './history-fold-throttle.js'
import { reserveTileBlob, reserveTileBlobUpload, storeTileBlob } from './tile-blobs.js'
import type { TemplateTileStatusRecord, TileObservation, TileStore } from './tiles/store.js'

export const MAX_CANVAS_TILE_BYTES = 8 * 1024 * 1024
/** Ordinary device-clock skew a reporter's observation time may run ahead of the server. */
const MAX_TILE_FUTURE_SKEW_SECONDS = 5 * 60
/** Tiles of one offer batch processed at the same time; a viewport rarely spans more. */
const OFFER_TILE_CONCURRENCY = 4

interface IngestStores {
  readonly blobs: BlobStore
  readonly sql: TileBlobStore & TileStore & AlarmStore & HistoryStore
  readonly statusReadModel: StatusReadModelPort
}

export interface Reporter {
  readonly wplaceUserId: number
  readonly displayName: string
  readonly tokenHash: string
}

export interface TileMetadata extends Reporter {
  readonly season: number
  readonly tile: TileCoord
  readonly hash: string
  readonly observedAt: Seconds
  readonly includeUnpublished: boolean
  /**
   * Whether the observation enters tile history. By default it does when no template covers the
   * tile or an unfinished one does; the mirror decides for its planned timelapse tiles itself.
   */
  readonly recordHistory?: boolean
}

/**
 * A reporter's claimed observation time. Client clocks can be wrong or hostile, and a future row
 * would outrank authoritative server scans until that time arrived.
 */
const clampObservedAt = (claimed: number): Seconds =>
  seconds(Math.min(claimed, Math.floor(Date.now() / 1_000) + MAX_TILE_FUTURE_SKEW_SECONDS))

export interface ProjectionSink {
  readonly add: (season: number, mutation: StatusProjectionMutation) => void
  /** Apply everything added, one projection RPC per season, and return each season's change. */
  readonly flush: () => Promise<ReadonlyMap<number, StatusProjectionChange>>
}

/** Coalesce one job's committed observations into at most one projection RPC per season. */
const createProjectionSink = (readModel: StatusProjectionPort): ProjectionSink => {
  const pending = new Map<number, StatusProjectionMutation[]>()
  return {
    add: (season, mutation) => {
      const mutations = pending.get(season) ?? []
      mutations.push(mutation)
      pending.set(season, mutations)
    },
    flush: async () => {
      const entries = [...pending]
      pending.clear()
      const changes = new Map<number, StatusProjectionChange>()
      await Promise.all(
        entries.map(async ([season, mutations]) => {
          const change = await applyMutations(readModel, season, mutations)
          if (change !== null) changes.set(season, change)
        }),
      )
      return changes
    },
  }
}

const applyMutations = (
  readModel: StatusProjectionPort,
  season: number,
  mutations: readonly StatusProjectionMutation[],
): Promise<StatusProjectionChange | null> => {
  const first = mutations[0]
  const last = mutations.at(-1)
  if (first === undefined || last === undefined) return Promise.resolve(null)
  const contiguous = mutations.every(
    (mutation, index) => index === 0 || mutation.baseRevision === mutations[index - 1]?.revision,
  )
  return bestEffort(() =>
    readModel.applyCommittedChange(season, {
      baseRevision: first.baseRevision,
      revision: last.revision,
      ...(contiguous
        ? {
            invalidatedTiles: [
              ...new Set(mutations.flatMap((mutation) => mutation.invalidatedTiles ?? [])),
            ],
            publicInvalidatedTiles: [
              ...new Set(mutations.flatMap((mutation) => mutation.publicInvalidatedTiles ?? [])),
            ],
            changes: mutations.flatMap((mutation) => mutation.changes),
          }
        : { forceReconcile: true, changes: [] }),
    }),
  )
}

/** What one ingest job holds back until all of its observations have committed. */
export interface IngestSinks {
  readonly projection: ProjectionSink
  readonly artifacts: DerivedArtifactWriteBatch
}

export const createIngestSinks = (
  ports: { readonly blobs: BlobStore; readonly statusReadModel: StatusProjectionPort },
  writer: DerivedArtifactWriter = derivedArtifactWriter,
): IngestSinks => ({
  projection: createProjectionSink(ports.statusReadModel),
  artifacts: createDerivedArtifactWriteBatch(ports.blobs, writer),
})

/** Publish the coalesced projection first, then hand the derived writes on. */
export const flushIngestSinks = async (
  sinks: IngestSinks,
): Promise<ReadonlyMap<number, StatusProjectionChange>> => {
  try {
    return await sinks.projection.flush()
  } finally {
    sinks.artifacts.flush()
  }
}

/** Reporters' uploads and offers are client claims. The fetcher's mirror is authoritative. */
type ObservationSource = Extract<IngestCommand, 'upload' | 'offer' | 'mirror'>

const statusValue = (status: TemplateTileStatusRecord) => ({
  correct: status.correct,
  wrong: status.wrong,
  blank: status.blank,
  ...(status.colours === undefined ? {} : { colours: status.colours }),
  observedAt: status.observedAt,
})

/**
 * Persist an accepted tile: the observation row, its raw history entry, and a status per template
 * chunk the tile carries. Its projection mutation and derived masks go to `sinks`.
 *
 * Records even with zero covering templates. Reporter paths refuse or ignore an uncovered tile
 * first, but the fetcher deliberately mirrors planned 16:9 context tiles no template covers, for
 * the timelapse viewer.
 */
const recordObservation = async (
  ports: IngestStores,
  metadata: TileMetadata,
  bytes: Uint8Array,
  reservationId: string,
  source: ObservationSource,
  sinks: IngestSinks,
): Promise<void> => {
  const authoritative = source === 'mirror'
  const timed = <Value>(stage: IngestStage, run: () => Promise<Value>) =>
    ingestTimings.timed(source, stage, run)
  const canvas = await timed('decode', () => decodeCanvasBytes(metadata.hash, bytes))
  const prepared = await timed('prepare', () =>
    ports.statusReadModel.prepareTileGenerationCommit(metadata.season, metadata.tile),
  )
  const finishPrepared = () =>
    bestEffort(() =>
      ports.statusReadModel.finishTileGenerationCommit(metadata.season, metadata.tile, prepared),
    )
  const observedAtMs = millis(metadata.observedAt * 1_000)
  const { targets, classified, committed } = await (async () => {
    try {
      // Coverage is read after the prepare above, so a template published, replaced, or removed
      // while the caller reserved and stored bytes is classified against its current state.
      const targets = await timed('targets', () =>
        ports.sql.listTelemetryTargets(metadata.season, metadata.tile, metadata.includeUnpublished),
      )
      const classified = (
        await timed('classify', () =>
          Promise.all(
            targets.map(async (target) => {
              const classification = await classifyTarget(ports, target, canvas, metadata.hash)
              return classification === null ? [] : [{ target, classification }]
            }),
          ),
        )
      ).flat()
      const statuses = classified.map(
        ({ target, classification }): TemplateTileStatusRecord => ({
          templateId: target.templateId,
          versionId: target.versionId,
          tile: metadata.tile,
          correct: classification.correct,
          wrong: classification.wrong,
          blank: classification.blank,
          colours: classification.colours,
          observedAt: observedAtMs,
        }),
      )
      const observation: TileObservation = {
        season: metadata.season,
        tile: metadata.tile,
        hash: metadata.hash,
        observedAt: observedAtMs,
        reportedAt: metadata.observedAt,
        reportedWithToken: metadata.tokenHash,
        reportedByUserId: metadata.wplaceUserId,
      }
      await timed('painter', () =>
        ports.sql.rememberPainter(metadata.wplaceUserId, metadata.displayName, observedAtMs),
      )
      const recordHistory =
        metadata.recordHistory ??
        (targets.length === 0 || targets.some((target) => !target.finished))
      const committed = await timed('commit', () =>
        ports.sql.commitTileObservation({
          reservationId,
          now: millis(Date.now()),
          observation,
          statuses,
          recordHistory,
          authoritative,
          includeUnpublished: metadata.includeUnpublished,
        }),
      )
      if (!committed) {
        throw new Error(`tile blob reservation expired before ${metadata.hash} could be recorded`)
      }
      return { targets, classified, committed }
    } catch (error) {
      await finishPrepared()
      throw error
    }
  })()
  const visibleToPublic = targets.some((target) => target.published)
  await timed('projection', async () => {
    if (committed.current === null) {
      await finishPrepared()
      return
    }
    // Cache repair never changes the authoritative D1 commit before it. When it fails, the
    // prepared commit still has to leave the fence an earlier winner may be waiting behind.
    try {
      await ports.statusReadModel.applyCommittedTileGeneration(metadata.season, {
        ...committed.current,
        ...prepared,
        visibleToPublic,
        visibleToAdmin: targets.length > 0,
      })
    } catch (error) {
      console.error(error)
      await finishPrepared()
    }
  })
  if (committed.revision !== null) {
    sinks.projection.add(metadata.season, {
      baseRevision: committed.revision - 1,
      revision: committed.revision,
      invalidatedTiles: [tileKey(metadata.tile)],
      publicInvalidatedTiles: visibleToPublic ? [tileKey(metadata.tile)] : [],
      changes: committed.statusChanges.map(
        ({ published, totalPixels, colourTotals, previous, current }) => ({
          templateId: current.templateId,
          published,
          total: totalPixels,
          ...(colourTotals === undefined ? {} : { colourTotals }),
          previous: previous === null ? null : statusValue(previous),
          current: statusValue(current),
        }),
      ),
    })
  }
  // The fetcher evaluates its whole scan after its batch. A reporter's observation evaluates only
  // changed templates, before it is acknowledged: initial incomplete work seeds a baseline, and a
  // newly lost correct pixel opens an episode at once.
  const alarmChanges = committed.statusChanges.filter(
    ({ previous, current }) => previous === null || previous.correct !== current.correct,
  )
  const revision = committed.revision
  await timed('alarms', async () => {
    if (authoritative || revision === null || alarmChanges.length === 0) return
    await evaluateAlarms(ports, async (evaluate) => {
      for (const change of alarmChanges) {
        const { previous, current, previousTemplateCorrect, previousTemplateObservedAt } = change
        await evaluate(
          metadata.season,
          {
            templateId: current.templateId,
            versionId: current.versionId,
            total: change.totalPixels,
            correct: previousTemplateCorrect - (previous?.correct ?? 0) + current.correct,
            observedAt: millis(Math.max(current.observedAt, previousTemplateObservedAt)),
            observationRevision: revision,
          },
          { kind: 'observation', previousCorrect: previousTemplateCorrect },
        )
      }
    })
  })
  for (const { target, classification } of classified) {
    sinks.artifacts.add(classificationKey(target, metadata.hash), classification.mask)
  }
  await timed('historyFold', async () => {
    const outcome = await foldTileHistoryThrottled(
      ports.sql,
      metadata.season,
      metadata.tile,
      seconds(Math.floor(Date.now() / 1_000)),
    )
    ingestTimings.count(`historyFold.${outcome}`)
  })
}

/** Refuse bytes that are empty, oversized, or not the content their hash names. */
const checkTileBytes = async (bytes: Uint8Array, hash: string): Promise<void> => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CANVAS_TILE_BYTES) {
    throw new InvalidTileError(`tile must be 1..${MAX_CANVAS_TILE_BYTES} bytes`)
  }
  const actual = await ingestTimings.timed('upload', 'hash', () => sha256Hex(bytes))
  if (actual !== hash) throw new InvalidTileError('tile bytes do not match their sha256')
}

/** Store new bytes once, then record them; a failure releases the reservation for GC. */
const storeAndRecord = async (
  ports: IngestStores,
  metadata: TileMetadata,
  bytes: Uint8Array,
  source: ObservationSource,
  sinks: IngestSinks,
): Promise<void> => {
  const reservation = await ingestTimings.timed(source, 'reserve', () =>
    reserveTileBlobUpload(ports, metadata.hash),
  )
  try {
    // Many reporters upload one fresh hash inside the same commit window. The generation's object
    // holds the bytes once; the reservation keeps GC away, so only the observation still needs
    // recording for each of them.
    await ingestTimings.timed(source, 'blobPut', () => storeTileBlob(ports, reservation, bytes))
    await recordObservation(ports, metadata, bytes, reservation.id, source, sinks)
  } catch (error) {
    await ports.sql.releaseTileBlobReservation(reservation.id)
    throw error
  }
}

const uploadTilePromise = async (
  ports: IngestStores,
  claimed: TileMetadata,
  bytes: Uint8Array,
): Promise<StatusProjectionChange | null> => {
  const metadata = { ...claimed, observedAt: clampObservedAt(claimed.observedAt) }
  await checkTileBytes(bytes, metadata.hash)
  const targets = await ingestTimings.timed('upload', 'targets', () =>
    ports.sql.listTelemetryTargets(metadata.season, metadata.tile, metadata.includeUnpublished),
  )
  if (targets.length === 0) throw new InvalidTileError('tile is not covered by a visible template')
  const sinks = createIngestSinks(ports)
  let changes: ReadonlyMap<number, StatusProjectionChange> = new Map()
  try {
    await storeAndRecord(ports, metadata, bytes, 'upload', sinks)
  } finally {
    // A commit followed by a failure still owes its projection.
    changes = await flushIngestSinks(sinks)
  }
  return changes.get(metadata.season) ?? null
}

export type MirrorOutcome = 'stored' | 'unchanged'

const mirrorTilePromise = async (
  ports: IngestStores,
  metadata: TileMetadata,
  bytes: Uint8Array,
  latestHash: string | null,
  sinks: IngestSinks,
): Promise<MirrorOutcome> => {
  if (latestHash !== metadata.hash) {
    await storeAndRecord(ports, metadata, bytes, 'mirror', sinks)
    return 'stored'
  }
  // The latest observation already holds these bytes: reclassify them against current artwork
  // without another object write or history entry.
  const held = await reserveTileBlob(ports, metadata.hash)
  if (held === null) throw new Error(`authoritative tile blob ${metadata.hash} is unavailable`)
  await recordObservation(
    ports,
    { ...metadata, recordHistory: false },
    bytes,
    held.reservation.id,
    'mirror',
    sinks,
  )
  return 'unchanged'
}

const ingestStores = Effect.gen(function* () {
  return {
    blobs: yield* BlobStoreService,
    sql: yield* SqlStoreService,
    statusReadModel: yield* StatusReadModelService,
  }
})

type IngestServices = BlobStoreService | SqlStoreService | StatusReadModelService

/** A refused tile answers as the caller's mistake; anything else is a storage failure. */
type IngestError = Effect.Error<ReturnType<typeof fromPort>>

/** Validate and persist one reporter's uploaded tile, returning its projection change. */
export const uploadTile = (
  metadata: TileMetadata,
  bytes: Uint8Array,
): Effect.Effect<StatusProjectionChange | null, IngestError, IngestServices> =>
  Effect.flatMap(ingestStores, (ports) =>
    fromPort('uploadTile', () => uploadTilePromise(ports, metadata, bytes)),
  )

/**
 * Record one tile the server fetched, sized, and hashed itself. Bytes the latest observation
 * already holds are reclassified only; new bytes are stored. Its projection and masks wait in
 * `sinks`.
 */
export const mirrorTile = (
  metadata: TileMetadata,
  bytes: Uint8Array,
  options: { readonly latestHash: string | null; readonly sinks: IngestSinks },
): Effect.Effect<MirrorOutcome, IngestError, IngestServices> =>
  Effect.flatMap(ingestStores, (ports) =>
    fromPort('mirrorTile', () =>
      mirrorTilePromise(ports, metadata, bytes, options.latestHash, options.sinks),
    ),
  )

/** One reporter's batch of tile hashes for one season, each keyed by its `x/y` tile key. */
export interface TileOffers {
  readonly season: number
  readonly reporter: Reporter
  readonly includeUnpublished: boolean
  readonly offers: readonly {
    readonly tile: string
    readonly sha256: string
    readonly ts: number
  }[]
}

/** Each offered tile key lands in exactly one of `wanted`, `acknowledged`, and `rejected`. */
export interface TileOfferResult {
  /** Tiles whose bytes the server needs uploaded. */
  readonly wanted: readonly string[]
  /** Tiles already current, or recorded now from bytes the server held. */
  readonly acknowledged: readonly string[]
  /** Tiles no visible template covers. */
  readonly rejected: readonly string[]
  readonly projection: StatusProjectionChange | null
  readonly cacheOutcome: 'hit' | 'miss' | 'stale'
  /** Authority for the uploads that follow, when the read model issues one. */
  readonly coverageToken?: string
}

type OfferOutcome = 'cached' | 'ignored' | 'wanted' | 'recorded'

/** The tile cache only saves D1 work; when it cannot answer, every offer is resolved in D1. */
const CACHE_UNANSWERED: Pick<
  TileGenerationCacheRead,
  'acknowledgedDeliveryIds' | 'cacheOutcome' | 'coverageToken'
> = { acknowledgedDeliveryIds: [], cacheOutcome: 'miss', coverageToken: null }

/** Record an offer at once when the content-addressed bytes already exist. */
const offerTilePromise = async (
  ports: IngestStores,
  metadata: TileMetadata,
  sinks: IngestSinks,
): Promise<OfferOutcome> => {
  const targets = await ingestTimings.timed('offer', 'targets', () =>
    ports.sql.listTelemetryTargets(metadata.season, metadata.tile, metadata.includeUnpublished),
  )
  if (targets.length === 0) return 'ignored'
  const held = await ingestTimings.timed('offer', 'reserve', () =>
    reserveTileBlob(ports, metadata.hash),
  )
  if (held === null) return 'wanted'
  await recordObservation(ports, metadata, held.bytes, held.reservation.id, 'offer', sinks)
  return 'recorded'
}

/** Decide which offered tiles the server needs, recording tiles whose bytes it already holds. */
export const offerTiles = (
  batch: TileOffers,
): Effect.Effect<TileOfferResult, IngestError, IngestServices> =>
  Effect.gen(function* () {
    const ports = yield* ingestStores
    if (new Set(batch.offers.map((offer) => offer.tile)).size !== batch.offers.length) {
      return yield* Effect.fail(
        new ValidationError({ message: 'tile offer batch contains duplicates' }),
      )
    }
    const offers: { readonly key: string; readonly metadata: TileMetadata }[] = []
    for (const offer of batch.offers) {
      const tile = parseTileKey(offer.tile)
      if (tile === null) {
        return yield* Effect.fail(new ValidationError({ message: 'invalid tile offer batch' }))
      }
      offers.push({
        key: offer.tile,
        metadata: {
          ...batch.reporter,
          season: batch.season,
          tile,
          hash: offer.sha256,
          observedAt: clampObservedAt(offer.ts),
          includeUnpublished: batch.includeUnpublished,
        },
      })
    }
    const current =
      offers.length === 0
        ? null
        : ((yield* Effect.promise(() =>
            bestEffort(() =>
              ports.statusReadModel.resolveCurrentTileOffers(
                batch.season,
                batch.includeUnpublished ? 'admin' : 'public',
                offers.map(({ key, metadata }) => ({
                  deliveryId: key,
                  tile: metadata.tile,
                  hash: metadata.hash,
                })),
              ),
            ),
          )) ?? CACHE_UNANSWERED)
    const cached = new Set(current?.acknowledgedDeliveryIds)
    const coverageToken = current?.coverageToken ?? undefined
    const sinks = createIngestSinks(ports)
    // Each tile is its own observation on its own rows, so tiles run concurrently; in sequence a
    // multi-tile offer would outlast the client's deadline. Once one fails, queued tiles do not
    // start, but tiles in flight finish, so the flush below sees every commit and none misses
    // projection repair or artifacts.
    let firstFailure: IngestError | undefined
    const settled = yield* Effect.forEach(
      offers,
      ({ key, metadata }): Effect.Effect<Result.Result<OfferOutcome, IngestError>> => {
        if (firstFailure !== undefined) return Effect.succeed(Result.fail(firstFailure))
        if (cached.has(key)) return Effect.succeed(Result.succeed('cached'))
        return Effect.map(
          Effect.result(fromPort('offerTile', () => offerTilePromise(ports, metadata, sinks))),
          (result) => {
            if (Result.isFailure(result)) firstFailure ??= result.failure
            return result
          },
        )
      },
      { concurrency: OFFER_TILE_CONCURRENCY },
    )
    const changes = yield* Effect.promise(() => flushIngestSinks(sinks))
    if (firstFailure !== undefined) return yield* Effect.fail(firstFailure)
    const keysWith = (wanted: (outcome: OfferOutcome) => boolean) =>
      offers.flatMap(({ key }, index) => {
        const entry = settled[index]
        return entry !== undefined && Result.isSuccess(entry) && wanted(entry.success) ? [key] : []
      })
    return {
      wanted: keysWith((outcome) => outcome === 'wanted'),
      acknowledged: keysWith((outcome) => outcome === 'cached' || outcome === 'recorded'),
      rejected: keysWith((outcome) => outcome === 'ignored'),
      projection: changes.get(batch.season) ?? null,
      cacheOutcome: current?.cacheOutcome ?? 'hit',
      ...(coverageToken === undefined ? {} : { coverageToken }),
    }
  })
