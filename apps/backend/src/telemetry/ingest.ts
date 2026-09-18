import {
  decodePng,
  decodeWplaceIndexedPng,
  encodeMismatchMask,
  millis,
  PALETTE_RGB,
  type PaintEvent,
  quantiseToPalette,
  type Seconds,
  seconds,
  sha256Hex,
  TILE_SIZE,
  type TileCoord,
  TRANSPARENT_INDEX,
  tileKey,
  uuidV7,
  WORLD_PIXELS,
} from '@caelestis/shared'
import { Effect, Result } from 'effect'
import {
  type BlobStore,
  type ContributionDelta,
  type CounterDelta,
  type CounterStore,
  type PainterTelemetryBucket,
  painterBucketResolution,
  type SqlStore,
  type TelemetryTarget,
  type TemplateTileStatusRecord,
  type TileObservation,
} from '../ports/index.js'
import {
  BlobStoreService,
  CounterStoreService,
  SqlStoreService,
  StatusReadModelService,
} from '../runtime/backend-runtime.js'
import { TelemetryStorageError, TelemetryValidationError } from '../runtime/errors.js'
import type {
  StatusProjectionChange,
  StatusProjectionMutation,
} from '../status-read-model/model.js'
import {
  finishTileGenerationCommit,
  prepareTileGenerationCommit,
  publishAlarmChange,
  publishDashboardChange,
  repairCommittedStatusProjection,
  repairCommittedTileGeneration,
  resolveCurrentTileOffers,
  type StatusReadModelPort,
} from '../status-read-model/port.js'
import { classifyChunk } from './classify-chunk.js'
import { decodedPixelCache } from './decoded-pixel-cache.js'
import { derivedArtifactWriter } from './derived-artifact-writer.js'
import {
  createDerivedArtifactWriteBatch,
  type DerivedArtifactWriteBatch,
  readMismatchArtifact,
  writeMismatchArtifact,
} from './derived-classification.js'
import { foldTileHistoryThrottled } from './history-fold-throttle.js'
import { type IngestCommand, type IngestStage, ingestTimings } from './ingest-timing.js'
import { sharedClassifier } from './shared-classification.js'
import { readTileBlob, reserveTileBlob, reserveTileBlobUpload } from './tile-blobs.js'

export const MAX_CANVAS_TILE_BYTES = 8 * 1024 * 1024
/** Tiles of one offer batch processed at the same time; a viewport rarely spans more. */
export const OFFER_TILE_CONCURRENCY = 4

interface BlobStores {
  readonly blobs: BlobStore
}

interface BlobSqlStores extends BlobStores {
  readonly sql: SqlStore
}

interface IngestStores extends BlobSqlStores {
  readonly statusReadModel: StatusReadModelPort
}

const applyStatusProjectionMutations = async (
  readModel: StatusReadModelPort,
  season: number,
  mutations: readonly StatusProjectionMutation[],
): Promise<StatusProjectionChange | null> => {
  const first = mutations[0]
  const last = mutations.at(-1)
  if (first === undefined || last === undefined) return null
  const contiguous = mutations.every(
    (mutation, index) => index === 0 || mutation.baseRevision === mutations[index - 1]?.revision,
  )
  return repairCommittedStatusProjection(readModel, season, {
    baseRevision: first.baseRevision,
    revision: last.revision,
    ...(contiguous
      ? {
          invalidatedTiles: [
            ...new Set(mutations.flatMap((mutation) => mutation.invalidatedTiles ?? [])),
          ],
          changes: mutations.flatMap((mutation) => mutation.changes),
        }
      : { forceReconcile: true, changes: [] }),
  })
}

export interface StatusProjectionBatch {
  readonly add: (season: number, mutation: StatusProjectionMutation) => void
  readonly flush: () => Promise<void>
}

/** Coalesce one server job into at most one projection RPC per touched season. */
export const createStatusProjectionBatch = (
  readModel: StatusReadModelPort,
): StatusProjectionBatch => {
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
      await Promise.all(
        entries.map(([season, mutations]) =>
          applyStatusProjectionMutations(readModel, season, mutations),
        ),
      )
    },
  }
}

interface TelemetryStores extends BlobSqlStores {
  readonly counters: CounterStore
}

interface Reporter {
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
}

interface ChunkRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

const chunkRect = (target: TelemetryTarget): ChunkRect | null => {
  const tileLeft = target.tileX * TILE_SIZE
  const tileTop = target.tileY * TILE_SIZE
  const spans =
    target.bbox.minX < target.bbox.maxX
      ? [{ start: target.bbox.minX, end: target.bbox.maxX }]
      : [
          { start: target.bbox.minX, end: WORLD_PIXELS },
          { start: 0, end: target.bbox.maxX },
        ]
  const span = spans.find(
    (candidate) => candidate.start < tileLeft + TILE_SIZE && candidate.end > tileLeft,
  )
  if (span === undefined) return null
  const startX = Math.max(span.start, tileLeft)
  const endX = Math.min(span.end, tileLeft + TILE_SIZE)
  const startY = Math.max(target.bbox.minY, tileTop)
  const endY = Math.min(target.bbox.maxY, tileTop + TILE_SIZE)
  if (startX >= endX || startY >= endY) return null
  return {
    left: startX - tileLeft,
    top: startY - tileTop,
    width: endX - startX,
    height: endY - startY,
  }
}

const decodeCanvas = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const image = await decodePng(bytes)
  if (image.width !== TILE_SIZE || image.height !== TILE_SIZE) {
    throw new RangeError(
      `canvas tile is ${image.width}x${image.height}, expected ${TILE_SIZE}x${TILE_SIZE}`,
    )
  }
  return quantiseToPalette(image.pixels, PALETTE_RGB).indices
}

const decodeCanvasInput = (hash: string, bytes: Uint8Array): Promise<Uint8Array> =>
  decodedPixelCache.get(
    `canvas:${hash}`,
    () => decodeCanvas(bytes),
    (canvas) => canvas.byteLength,
  )

const readDecodedCanvas = (ports: BlobSqlStores, hash: string): Promise<Uint8Array | null> =>
  decodedPixelCache.get(
    `canvas:${hash}`,
    async () => {
      const bytes = await readTileBlob(ports, hash)
      return bytes === null ? null : decodeCanvas(bytes).catch(() => null)
    },
    (canvas) => canvas?.byteLength ?? 0,
  )

const readDecodedChunk = (ports: BlobStores, hash: string) =>
  decodedPixelCache.get(
    `chunk:${hash}`,
    async () => {
      const bytes = await ports.blobs.get('chunks', hash)
      return bytes === null ? null : decodeWplaceIndexedPng(bytes)
    },
    (chunk) => chunk?.indices.byteLength ?? 0,
  )

interface ClassifiedTarget {
  readonly status: TemplateTileStatusRecord
  readonly mask: Uint8Array
}

const persistMismatchArtifact = async (
  blobs: BlobStore,
  identity: Parameters<typeof writeMismatchArtifact>[1],
  mask: Uint8Array,
): Promise<void> => {
  try {
    await writeMismatchArtifact(blobs, identity, mask)
  } catch (error) {
    // This is a reconstructible optimization. Never roll back or hide accepted authoritative data
    // because its derived copy could not be written; a later read will retry the same key.
    console.error('failed to persist derived mismatch artifact', error)
  }
}

/**
 * Classify one target against a decoded canvas.
 *
 * The counts and mask depend only on the chunk and canvas content, so identical work from other
 * reporters is shared; the observation timestamp is stamped per caller afterwards.
 */
const classifyTarget = async (
  ports: BlobStores,
  target: TelemetryTarget,
  canvas: Uint8Array,
  canvasHash: string,
  observedAt: number,
): Promise<ClassifiedTarget | null> => {
  const rect = chunkRect(target)
  if (rect === null) return null
  let computed = false
  const shared = await sharedClassifier.classify(
    {
      templateId: target.templateId,
      versionId: target.versionId,
      tile: { x: target.tileX, y: target.tileY },
      chunkHash: target.hash,
      canvasHash,
    },
    async () => {
      computed = true
      const chunk = await readDecodedChunk(ports, target.hash)
      if (chunk === null || chunk.width !== rect.width || chunk.height !== rect.height) return null
      const { correct, wrong, blank, colours, classifications } = classifyChunk(
        chunk.indices,
        canvas,
        rect,
      )
      return { correct, wrong, blank, colours, mask: encodeMismatchMask(rect, classifications) }
    },
  )
  ingestTimings.count(computed ? 'classification.computed' : 'classification.shared')
  if (shared === null) return null
  return {
    status: {
      templateId: target.templateId,
      versionId: target.versionId,
      tile: { x: target.tileX, y: target.tileY },
      correct: shared.correct,
      wrong: shared.wrong,
      blank: shared.blank,
      colours: shared.colours,
      observedAt: millis(observedAt),
    },
    mask: shared.mask,
  }
}

export type MismatchMaskRead =
  | { readonly kind: 'found'; readonly bytes: Uint8Array }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unobserved' }

export interface MismatchMaskQuery {
  readonly season: number
  readonly templateId: string
  readonly versionId: string
  readonly tile: TileCoord
  readonly includeUnpublished: boolean
}

/** Read one server-owned classification mask from the latest accepted canvas observation. */
const readMismatchMaskPromise = async (
  ports: BlobSqlStores,
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
  const identity = { ...query, canvasHash: latest.hash }
  const artifact = await readMismatchArtifact(ports.blobs, identity)
  if (artifact !== null) return { kind: 'found', bytes: artifact }
  const canvas = await readDecodedCanvas(ports, latest.hash)
  if (canvas === null) return { kind: 'unobserved' }
  const classified = await classifyTarget(ports, target, canvas, latest.hash, latest.observedAt)
  if (classified === null) return { kind: 'unobserved' }
  await persistMismatchArtifact(ports.blobs, identity, classified.mask)
  return { kind: 'found', bytes: classified.mask }
}

/**
 * Persist an accepted tile: the observation row, its raw history entry, and a status per template
 * chunk the tile carries.
 *
 * Records unconditionally, even with zero covering templates. The reporter routes never reach here
 * uncovered — `uploadTile` refuses and `offerTile` answers `ignored` first — but the server's own
 * fetcher deliberately stores planned 16:9 context tiles no template covers, purely for the
 * timelapse viewer.
 */
const recordObservationPromise = async (
  ports: IngestStores,
  metadata: TileMetadata,
  bytes: Uint8Array,
  reservationId: string,
  options: {
    readonly recordHistory?: boolean
    readonly authoritative?: boolean
    readonly coverageToken?: string
    readonly artifactWriteBatch?: DerivedArtifactWriteBatch
    /** Which live command this observation belongs to, for stage timings. */
    readonly command?: IngestCommand
    readonly onCommitted?: (mutation: StatusProjectionMutation | null) => void | Promise<void>
  } = {},
): Promise<void> => {
  const command = options.command ?? 'upload'
  const timed = <Value>(stage: IngestStage, run: () => Promise<Value>) =>
    ingestTimings.timed(command, stage, run)
  const canvas = await timed('decode', () => decodeCanvasInput(metadata.hash, bytes))
  const preparedCoverageToken = await timed('prepare', () =>
    prepareTileGenerationCommit(ports.statusReadModel, metadata.season, metadata.tile),
  )
  const { targets, classified, committed } = await (async () => {
    try {
      // Coverage is read after the prepare above, so a template published, replaced, or removed
      // while the caller reserved and stored bytes is classified against its current state.
      const targets = await timed('targets', () =>
        ports.sql.listTelemetryTargets(metadata.season, metadata.tile, metadata.includeUnpublished),
      )
      const observedAtMs = metadata.observedAt * 1_000
      const classified = (
        await timed('classify', () =>
          Promise.all(
            targets.map((target) =>
              classifyTarget(ports, target, canvas, metadata.hash, observedAtMs),
            ),
          ),
        )
      ).filter((result): result is ClassifiedTarget => result !== null)
      const statuses = classified.map((result) => result.status)
      const observation: TileObservation = {
        season: metadata.season,
        tile: metadata.tile,
        hash: metadata.hash,
        observedAt: millis(observedAtMs),
        reportedAt: metadata.observedAt,
        reportedWithToken: metadata.tokenHash,
        reportedByUserId: metadata.wplaceUserId,
      }
      await timed('painter', () =>
        ports.sql.rememberPainter(
          metadata.wplaceUserId,
          metadata.displayName,
          millis(observedAtMs),
        ),
      )
      const recordHistory =
        options.recordHistory ??
        (targets.length === 0 || targets.some((target) => !target.finished))
      const committed = await timed('commit', () =>
        ports.sql.commitTileBlobReservation(
          reservationId,
          millis(Date.now()),
          observation,
          statuses,
          recordHistory,
          options.authoritative ?? false,
          metadata.includeUnpublished,
        ),
      )
      if (!committed) {
        throw new Error(`tile blob reservation expired before ${metadata.hash} could be recorded`)
      }
      return { targets, classified, committed }
    } catch (error) {
      if (preparedCoverageToken !== null) {
        await finishTileGenerationCommit(
          ports.statusReadModel,
          metadata.season,
          metadata.tile,
          preparedCoverageToken,
        )
      }
      throw error
    }
  })()
  // The server recomputed coverage after prepare. A client token only supports adapters that do not
  // implement prepare; it cannot invalidate the fresher server-owned result.
  const repairCoverageToken = preparedCoverageToken?.coverageToken ?? options.coverageToken
  const projectionStartedAt = performance.now()
  if (committed.current !== null && repairCoverageToken !== undefined) {
    await repairCommittedTileGeneration(ports.statusReadModel, metadata.season, {
      ...committed.current,
      coverageToken: repairCoverageToken,
      ...(preparedCoverageToken === null
        ? {}
        : {
            commitToken: preparedCoverageToken.commitToken,
            commitExpiresAt: preparedCoverageToken.commitExpiresAt,
          }),
      visibleToPublic: targets.some((target) => target.published),
      visibleToAdmin: targets.length > 0,
    })
  } else if (preparedCoverageToken !== null) {
    await finishTileGenerationCommit(
      ports.statusReadModel,
      metadata.season,
      metadata.tile,
      preparedCoverageToken,
    )
  }
  const mutation: StatusProjectionMutation | null =
    committed.revision === null
      ? null
      : {
          baseRevision: committed.revision - 1,
          revision: committed.revision,
          invalidatedTiles: [tileKey(metadata.tile)],
          changes: committed.statusChanges.map(
            ({ published, totalPixels, colourTotals, previous, current }) => {
              const value = (status: TemplateTileStatusRecord) => ({
                correct: status.correct,
                wrong: status.wrong,
                blank: status.blank,
                ...(status.colours === undefined ? {} : { colours: status.colours }),
                observedAt: status.observedAt,
              })
              return {
                templateId: current.templateId,
                published,
                total: totalPixels,
                ...(colourTotals === undefined ? {} : { colourTotals }),
                previous: previous === null ? null : value(previous),
                current: value(current),
              }
            },
          ),
        }
  await options.onCommitted?.(mutation)
  ingestTimings.record(command, 'projection', performance.now() - projectionStartedAt)
  // Evaluate only changed templates, before acknowledging this observation. Initial incomplete
  // work seeds a baseline; a newly lost correct pixel opens an episode immediately.
  const alarmChanges = committed.statusChanges.filter(
    ({ previous, current }) => previous === null || previous.correct !== current.correct,
  )
  // The fetcher evaluates its complete scan/follow-up after its authoritative tile batch.
  const alarmsStartedAt = performance.now()
  if (options.authoritative !== true && committed.revision !== null && alarmChanges.length > 0) {
    for (const {
      previous,
      current,
      previousTemplateCorrect,
      previousTemplateObservedAt,
      totalPixels,
    } of alarmChanges) {
      await ports.sql.evaluateTemplateAlarm(
        {
          templateId: current.templateId,
          versionId: current.versionId,
          total: totalPixels,
          correct: previousTemplateCorrect - (previous?.correct ?? 0) + current.correct,
          observedAt: millis(Math.max(current.observedAt, previousTemplateObservedAt)),
          observationRevision: committed.revision,
        },
        {
          kind: 'observation',
          previousCorrect: previousTemplateCorrect,
        },
        uuidV7(),
      )
    }
    await publishAlarmChange(ports.statusReadModel, metadata.season)
  }
  ingestTimings.record(command, 'alarms', performance.now() - alarmsStartedAt)
  // Publish the authoritative revision first. A caller processing many tiles owns one shared batch
  // and flushes it only after its coalesced projection; standalone calls flush their local batch.
  const ownsArtifactWriteBatch = options.artifactWriteBatch === undefined
  const artifactWriteBatch =
    options.artifactWriteBatch ??
    createDerivedArtifactWriteBatch(ports.blobs, { writer: derivedArtifactWriter })
  for (const { status, mask } of classified) {
    artifactWriteBatch.add(
      {
        templateId: status.templateId,
        versionId: status.versionId,
        tile: status.tile,
        canvasHash: metadata.hash,
      },
      mask,
    )
  }
  if (ownsArtifactWriteBatch) await timed('artifacts', () => artifactWriteBatch.flush())
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

/** Reclassify bytes already held by the current canvas hash without another R2 upload or history fold. */
const refreshAuthoritativeTilePromise = async (
  ports: IngestStores,
  metadata: TileMetadata,
  bytes: Uint8Array,
  projectionBatch?: StatusProjectionBatch,
  artifactWriteBatch?: DerivedArtifactWriteBatch,
): Promise<StatusProjectionChange | null> => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CANVAS_TILE_BYTES) {
    throw new RangeError(`tile must be 1..${MAX_CANVAS_TILE_BYTES} bytes`)
  }
  const actualHash = await sha256Hex(bytes)
  if (actualHash !== metadata.hash) throw new RangeError('tile bytes do not match their sha256')
  const held = await reserveTileBlob(ports, metadata.hash)
  if (held === null) throw new Error(`authoritative tile blob ${metadata.hash} is unavailable`)
  let projection: StatusProjectionChange | null = null
  await recordObservationPromise(ports, metadata, bytes, held.reservation.id, {
    recordHistory: false,
    authoritative: true,
    ...(artifactWriteBatch === undefined ? {} : { artifactWriteBatch }),
    onCommitted: async (mutation) => {
      if (mutation === null) return
      if (projectionBatch !== undefined) projectionBatch.add(metadata.season, mutation)
      else {
        projection = await repairCommittedStatusProjection(
          ports.statusReadModel,
          metadata.season,
          mutation,
        )
      }
    },
  })
  return projection
}

type OfferTileOutcome = 'ignored' | 'wanted' | 'recorded'

/** Process an offer immediately when the content-addressed bytes already exist. */
const offerTilePromise = async (
  ports: IngestStores,
  metadata: TileMetadata,
  options: {
    readonly coverageToken?: string
    readonly artifactWriteBatch?: DerivedArtifactWriteBatch
    readonly onCommitted?: (mutation: StatusProjectionMutation | null) => void | Promise<void>
  } = {},
): Promise<'ignored' | 'wanted' | 'recorded'> => {
  const targets = await ingestTimings.timed('offer', 'targets', () =>
    ports.sql.listTelemetryTargets(metadata.season, metadata.tile, metadata.includeUnpublished),
  )
  if (targets.length === 0) return 'ignored'
  const held = await ingestTimings.timed('offer', 'reserve', () =>
    reserveTileBlob(ports, metadata.hash),
  )
  if (held === null) return 'wanted'
  await recordObservationPromise(ports, metadata, held.bytes, held.reservation.id, {
    command: 'offer',
    ...(options.coverageToken === undefined ? {} : { coverageToken: options.coverageToken }),
    ...(options.artifactWriteBatch === undefined
      ? {}
      : { artifactWriteBatch: options.artifactWriteBatch }),
    ...(options.onCommitted === undefined ? {} : { onCommitted: options.onCommitted }),
  })
  return 'recorded'
}

/** True when the registered generation for this hash is active under the reserved key. */
const tileBytesAlreadyStored = async (
  ports: BlobSqlStores,
  hash: string,
  blobKey: string,
): Promise<boolean> => {
  const registered = await ports.sql.readTileBlob(hash)
  return registered !== null && registered.state === 'active' && registered.blobKey === blobKey
}

/** Tile-object PUTs in flight on this runtime, by blob key, so concurrent uploaders share one. */
const inFlightTilePuts = new Map<string, Promise<void>>()

/**
 * Store one generation's bytes at most once at a time.
 *
 * Reporters that offer the same fresh hash inside one commit window all reserve the same
 * `uploading` generation, and none of them sees it `active` yet. The first PUT for a key is
 * shared with every concurrent caller; a failed PUT rejects them all so each retries its own.
 */
const storeTileBytesOnce = async (
  ports: BlobSqlStores,
  hash: string,
  blobKey: string,
  bytes: Uint8Array,
): Promise<void> => {
  if (storedTileBlobKeys.has(blobKey)) {
    ingestTimings.count('upload.blobPut.skipped')
    return
  }
  const joined = inFlightTilePuts.get(blobKey)
  if (joined !== undefined) {
    ingestTimings.count('upload.blobPut.joined')
    return joined
  }
  // Register before any await: the active-state read and the PUT belong to one owner, so a
  // caller arriving during either joins it instead of racing past the lookup.
  const work = (async () => {
    if (!(await tileBytesAlreadyStored(ports, hash, blobKey))) {
      await ports.blobs.put('tiles', blobKey, bytes)
    } else {
      ingestTimings.count('upload.blobPut.skipped')
    }
    rememberStoredTileBlobKey(blobKey)
  })().finally(() => {
    inFlightTilePuts.delete(blobKey)
  })
  inFlightTilePuts.set(blobKey, work)
  return work
}

/**
 * Blob keys whose bytes this runtime has stored or seen active.
 *
 * A generation stays `uploading` until its owner's observation commits, which is long after the
 * PUT settled, and every reporter reserving it in that gap would PUT again. A restored generation
 * always gets a fresh key, so remembering a key can never point at bytes that were reclaimed.
 * Dropping an entry only costs one state read.
 */
const STORED_TILE_BLOB_KEYS_LIMIT = 512
const storedTileBlobKeys = new Set<string>()

const rememberStoredTileBlobKey = (blobKey: string): void => {
  storedTileBlobKeys.delete(blobKey)
  storedTileBlobKeys.add(blobKey)
  if (storedTileBlobKeys.size > STORED_TILE_BLOB_KEYS_LIMIT) {
    const oldest = storedTileBlobKeys.values().next().value
    if (oldest !== undefined) storedTileBlobKeys.delete(oldest)
  }
}

const uploadTilePromise = async (
  ports: IngestStores,
  metadata: TileMetadata,
  bytes: Uint8Array,
  options: {
    readonly requireCoverage?: boolean
    readonly recordHistory?: boolean
    readonly authoritative?: boolean
    readonly coverageToken?: string
    readonly projectionBatch?: StatusProjectionBatch
    readonly artifactWriteBatch?: DerivedArtifactWriteBatch
  } = {},
): Promise<StatusProjectionChange | null> => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CANVAS_TILE_BYTES) {
    throw new RangeError(`tile must be 1..${MAX_CANVAS_TILE_BYTES} bytes`)
  }
  const actualHash = await ingestTimings.timed('upload', 'hash', () => sha256Hex(bytes))
  if (actualHash !== metadata.hash) throw new RangeError('tile bytes do not match their sha256')
  const targets = await ingestTimings.timed('upload', 'targets', () =>
    ports.sql.listTelemetryTargets(metadata.season, metadata.tile, metadata.includeUnpublished),
  )
  if (options.requireCoverage !== false && targets.length === 0) {
    throw new RangeError('tile is not covered by a visible template')
  }
  const reservation = await ingestTimings.timed('upload', 'reserve', () =>
    reserveTileBlobUpload(ports, actualHash),
  )
  let projection: StatusProjectionChange | null = null
  try {
    // Many reporters upload one fresh hash inside the same commit window. The generation's object
    // holds the bytes once; the reservation keeps GC away, so only the observation still needs
    // recording for each of them.
    await ingestTimings.timed('upload', 'blobPut', () =>
      storeTileBytesOnce(ports, actualHash, reservation.blobKey, bytes),
    )
    await recordObservationPromise(ports, metadata, bytes, reservation.id, {
      command: 'upload',
      ...(options.coverageToken === undefined ? {} : { coverageToken: options.coverageToken }),
      ...(options.recordHistory === undefined ? {} : { recordHistory: options.recordHistory }),
      ...(options.authoritative === undefined ? {} : { authoritative: options.authoritative }),
      ...(options.artifactWriteBatch === undefined
        ? {}
        : { artifactWriteBatch: options.artifactWriteBatch }),
      onCommitted: async (mutation) => {
        if (mutation === null) return
        if (options.projectionBatch !== undefined)
          options.projectionBatch.add(metadata.season, mutation)
        else
          projection = await repairCommittedStatusProjection(
            ports.statusReadModel,
            metadata.season,
            mutation,
          )
      },
    })
    return projection
  } catch (error) {
    await ports.sql.releaseTileBlobReservation(reservation.id)
    throw error
  }
}

const ourPaletteIndex = (wplaceIndex: number): number =>
  wplaceIndex === 0 ? TRANSPARENT_INDEX : wplaceIndex - 1

const dayOf = (timestamp: Seconds): Seconds => seconds(Math.floor(timestamp / 86_400) * 86_400)

/** Classify a fully accepted paint against server-owned template chunks and the latest tile anchor. */
const recordPaintPromise = async (
  ports: TelemetryStores,
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
    const targets = await ingestTimings.timed('paint', 'targets', () =>
      ports.sql.listTelemetryTargets(event.season, tile, includeUnpublished),
    )
    if (targets.length === 0) continue
    const previous = await ingestTimings.timed('paint', 'latestTile', async () => {
      const latest = await ports.sql.readLatestTile(event.season, tile)
      return latest === null ? null : await readDecodedCanvas(ports, latest.hash)
    })

    const classifyStartedAt = performance.now()
    for (const target of targets) {
      if (target.finished) continue
      const rect = chunkRect(target)
      if (rect === null) continue
      const chunk = await readDecodedChunk(ports, target.hash)
      if (chunk === null || chunk.width !== rect.width || chunk.height !== rect.height) continue
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
        const wanted =
          chunk.indices[(y - rect.top) * rect.width + (x - rect.left)] ?? TRANSPARENT_INDEX
        if (wanted === TRANSPARENT_INDEX) continue
        const painted = ourPaletteIndex(paintedTile.pixels.colors[index] ?? 0)
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

const storage = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new TelemetryStorageError({ operation, cause }),
  })

const upload = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof RangeError
        ? new TelemetryValidationError({ message: cause.message })
        : new TelemetryStorageError({ operation: 'uploadTile', cause }),
  })

/** Read one server-owned classification mask from the latest accepted canvas observation. */
export const readMismatchMask = (
  query: MismatchMaskQuery,
): Effect.Effect<MismatchMaskRead, TelemetryStorageError, BlobStoreService | SqlStoreService> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    return yield* storage('readMismatchMask', () => readMismatchMaskPromise({ blobs, sql }, query))
  })

/** Reclassify a server-owned tile without another R2 upload or history fold. */
export const refreshAuthoritativeTile = (
  metadata: TileMetadata,
  bytes: Uint8Array,
  options: {
    readonly projectionBatch?: StatusProjectionBatch
    readonly artifactWriteBatch?: DerivedArtifactWriteBatch
  } = {},
): Effect.Effect<
  StatusProjectionChange | null,
  TelemetryStorageError,
  BlobStoreService | SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    return yield* storage('refreshAuthoritativeTile', () =>
      refreshAuthoritativeTilePromise(
        { blobs, sql, statusReadModel },
        metadata,
        bytes,
        options.projectionBatch,
        options.artifactWriteBatch,
      ),
    )
  })

/** Decide whether the server needs one offered tile, recording known bytes immediately. */
export const offerTile = (
  metadata: TileMetadata,
): Effect.Effect<
  'ignored' | 'wanted' | 'recorded',
  TelemetryStorageError,
  BlobStoreService | SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    return yield* storage('offerTile', () =>
      offerTilePromise({ blobs, sql, statusReadModel }, metadata, {
        onCommitted: async (mutation) => {
          if (mutation === null) return
          await repairCommittedStatusProjection(statusReadModel, metadata.season, mutation)
        },
      }),
    )
  })

export const offerTiles = (
  offers: readonly { readonly key: string; readonly metadata: TileMetadata }[],
): Effect.Effect<
  readonly string[],
  TelemetryStorageError,
  BlobStoreService | SqlStoreService | StatusReadModelService
> => Effect.map(offerTilesWithOutcome(offers), (result) => result.wanted)

export interface TileOfferResult {
  readonly wanted: readonly string[]
  readonly acknowledged: readonly string[]
  readonly rejectedKeys: readonly string[]
  readonly accepted: number
  readonly alreadyKnown: number
  readonly rejected: number
  readonly projection: StatusProjectionChange | null
  readonly cacheOutcome: 'hit' | 'miss' | 'stale'
  readonly coverageTokens: ReadonlyMap<string, string>
}

/** Preserve per-offer decisions, cache authority tokens and capacity metrics for the route adapter. */
export const offerTilesWithOutcome = (
  offers: readonly { readonly key: string; readonly metadata: TileMetadata }[],
): Effect.Effect<
  TileOfferResult,
  TelemetryStorageError,
  BlobStoreService | SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    const wanted: string[] = []
    const acknowledged: string[] = []
    const rejectedKeys: string[] = []
    const mutations = new Map<number, StatusProjectionMutation[]>()
    let projection: StatusProjectionChange | null = null
    let alreadyKnown = 0
    let rejected = 0
    let cacheOutcome: 'hit' | 'miss' | 'stale' = 'hit'
    const coverageTokens = new Map<string, string>()
    const artifactWriteBatch = createDerivedArtifactWriteBatch(blobs, {
      writer: derivedArtifactWriter,
    })
    yield* Effect.acquireUseRelease(
      Effect.void,
      () =>
        Effect.gen(function* () {
          const cached = new Set<string>()
          const groups = new Map<string, typeof offers>()
          for (const offer of offers) {
            const groupKey = `${offer.metadata.season}:${offer.metadata.includeUnpublished ? 'admin' : 'public'}`
            groups.set(groupKey, [...(groups.get(groupKey) ?? []), offer])
          }
          for (const grouped of groups.values()) {
            const first = grouped[0]
            if (first === undefined) continue
            const read = yield* storage('resolveCurrentTileOffers', () =>
              resolveCurrentTileOffers(
                statusReadModel,
                first.metadata.season,
                first.metadata.includeUnpublished ? 'admin' : 'public',
                grouped.map((offer) => ({
                  deliveryId: offer.key,
                  tile: offer.metadata.tile,
                  hash: offer.metadata.hash,
                })),
              ),
            )
            for (const key of read.acknowledgedDeliveryIds) cached.add(key)
            if (read.coverageToken !== null) {
              coverageTokens.set(
                `${first.metadata.season}:${first.metadata.includeUnpublished ? 'admin' : 'public'}`,
                read.coverageToken,
              )
            }
            if (read.cacheOutcome === 'stale') cacheOutcome = 'stale'
            else if (read.cacheOutcome === 'miss' && cacheOutcome === 'hit') cacheOutcome = 'miss'
          }
          // Each tile in a batch is its own observation on its own rows. Processing them one
          // after another multiplied the database round trips of one tile by the batch size and
          // pushed multi-tile offers past the client's deadline. Every started offer settles
          // before the batch fails: an interrupted fiber cannot stop its storage promise, and the
          // release below must see every commit so none misses projection repair or artifacts.
          // Once any offer has failed, offers still queued do not start; offers already in
          // flight finish so the batch keeps the previous fail-fast shape without losing commits.
          let firstFailure: TelemetryStorageError | undefined
          const settled = yield* Effect.forEach(
            offers,
            (
              offer,
            ): Effect.Effect<Result.Result<OfferTileOutcome | 'cached', TelemetryStorageError>> => {
              if (firstFailure !== undefined) return Effect.succeed(Result.fail(firstFailure))
              if (cached.has(offer.key)) return Effect.succeed(Result.succeed('cached' as const))
              const coverageToken = coverageTokens.get(
                `${offer.metadata.season}:${offer.metadata.includeUnpublished ? 'admin' : 'public'}`,
              )
              return Effect.map(
                Effect.result(
                  storage('offerTile', () =>
                    offerTilePromise({ blobs, sql, statusReadModel }, offer.metadata, {
                      ...(coverageToken === undefined ? {} : { coverageToken }),
                      artifactWriteBatch,
                      onCommitted: (mutation) => {
                        if (mutation === null) return
                        const seasonMutations = mutations.get(offer.metadata.season) ?? []
                        seasonMutations.push(mutation)
                        mutations.set(offer.metadata.season, seasonMutations)
                      },
                    }),
                  ),
                ),
                (result) => {
                  if (Result.isFailure(result)) firstFailure ??= result.failure
                  return result
                },
              )
            },
            { concurrency: OFFER_TILE_CONCURRENCY },
          )
          const failed = settled.find(Result.isFailure)
          if (failed !== undefined) return yield* Effect.fail(failed.failure)
          for (const [index, offer] of offers.entries()) {
            const entry = settled[index]
            const outcome =
              entry !== undefined && Result.isSuccess(entry) ? entry.success : undefined
            if (outcome === 'cached' || outcome === 'recorded') {
              acknowledged.push(offer.key)
              alreadyKnown++
            } else if (outcome === 'wanted') wanted.push(offer.key)
            else {
              rejectedKeys.push(offer.key)
              rejected++
            }
          }
        }),
      () =>
        Effect.promise(async () => {
          try {
            for (const [season, seasonMutations] of mutations) {
              projection = await applyStatusProjectionMutations(
                statusReadModel,
                season,
                seasonMutations,
              )
            }
          } finally {
            await artifactWriteBatch.flush()
          }
        }),
    )
    return {
      wanted,
      acknowledged,
      rejectedKeys,
      accepted: wanted.length,
      alreadyKnown,
      rejected,
      projection,
      cacheOutcome,
      coverageTokens,
    }
  })

/** Validate and persist one uploaded tile without leaking storage failures into a 400 response. */
export const uploadTile = (
  metadata: TileMetadata,
  bytes: Uint8Array,
  options: {
    readonly requireCoverage?: boolean
    readonly recordHistory?: boolean
    readonly authoritative?: boolean
    readonly coverageToken?: string
    readonly projectionBatch?: StatusProjectionBatch
    readonly artifactWriteBatch?: DerivedArtifactWriteBatch
  } = {},
): Effect.Effect<
  StatusProjectionChange | null,
  TelemetryStorageError | TelemetryValidationError,
  BlobStoreService | SqlStoreService | StatusReadModelService
> =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const sql = yield* SqlStoreService
    const statusReadModel = yield* StatusReadModelService
    return yield* upload(() =>
      uploadTilePromise({ blobs, sql, statusReadModel }, metadata, bytes, options),
    )
  })

/** Classify one accepted paint with retry-safe counter and contribution application. */
export const recordPaint = (
  event: PaintEvent,
  reporterTokenHash: string,
  includeUnpublished: boolean,
): Effect.Effect<
  'duplicate' | 'partial' | 'recorded',
  TelemetryStorageError,
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
      yield* Effect.promise(() => publishDashboardChange(statusReadModel, event.season))
    }
    return result
  })
