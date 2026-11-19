import { type Millis, millis } from '@caelestis/shared'
import { ingestTimings } from '../metrics/ingest-timing.js'
import type { BlobStore } from '../ports/index.js'
import { BoundedCache } from '../runtime/bounded-cache.js'
import type { TileBlobObject, TileBlobReservation, TileBlobStore } from './blobs/store.js'

interface TileBlobStores {
  readonly blobs: BlobStore
  readonly sql: TileBlobStore
}

const RESERVATION_MILLISECONDS = 5 * 60 * 1_000
const INGEST_RECOVERY_LIMIT = 100
const TILE_BLOB_GC_SCAN_LIMIT = 10
const TILE_BLOB_GC_DELETE_LIMIT = 5

const TILE_BLOB_KEY = /^([0-9a-f]{64})(?:\/[0-9a-f-]{36})?$/

export type TileBlobGcMode = 'dry-run' | 'delete'

export interface TileBlobGcReport {
  readonly event: 'tile_blob_gc'
  readonly mode: TileBlobGcMode
  readonly scanned: number
  readonly candidates: number
  readonly referenced: number
  readonly invalidKeys: number
  readonly queued: number
  readonly blocked: number
  readonly retries: number
  readonly reclaimed: number
  readonly failed: number
  readonly completedSweeps: number
  readonly cursor?: string
}

interface TileBlobGcLogger {
  log(message: string): void
  error(message: string): void
}

const clock = (): Millis => millis(Date.now())

const reservationWindow = (now: Millis): Millis => millis(Number(now) + RESERVATION_MILLISECONDS)

/** A restored hash always gets a new physical key, so an older delete cannot remove its bytes. */
const generationKey = (hash: string): string => `${hash}/${crypto.randomUUID()}`

const reclaimTileBlob = async (
  ports: TileBlobStores,
  object: TileBlobObject,
  now: Millis,
): Promise<'reclaimed' | 'blocked' | 'missing'> => {
  const claim = await ports.sql.claimTileBlobDeletion(object.blobKey, now)
  if (claim !== 'claimed') return claim
  await ports.blobs.delete('tiles', [object.blobKey])
  await ports.sql.finishTileBlobDeletion(object.blobKey, now)
  return 'reclaimed'
}

/** Read the currently registered generation, with the pre-GC hash key as the migration fallback. */
export const readTileBlob = async (
  ports: TileBlobStores,
  hash: string,
): Promise<Uint8Array | null> => {
  const object = await ports.sql.readTileBlob(hash)
  return ports.blobs.get('tiles', object?.blobKey ?? hash)
}

/**
 * Reserve bytes that already exist.
 *
 * Legacy `tiles/<hash>` objects are read before registration. If GC fences the candidate between
 * that read and the reservation, the reservation loses and no SQL reference can be created.
 */
export const reserveTileBlob = async (
  ports: TileBlobStores,
  hash: string,
  now = clock(),
): Promise<{ readonly reservation: TileBlobReservation; readonly bytes: Uint8Array } | null> => {
  const reservationId = crypto.randomUUID()
  const expiresAt = reservationWindow(now)
  const registered = await ports.sql.readTileBlob(hash)
  if (registered !== null) {
    const reservation = await ports.sql.reserveTileBlob(hash, reservationId, now, expiresAt)
    if (reservation === null) return null
    const bytes = await ports.blobs.get('tiles', reservation.blobKey)
    if (bytes !== null) return { reservation, bytes }
    await ports.sql.releaseTileBlobReservation(reservation.id)
    return null
  }

  const bytes = await ports.blobs.get('tiles', hash)
  if (bytes === null) return null
  await ports.sql.noteTileBlobObject(hash, hash, now)
  const reservation = await ports.sql.reserveTileBlob(hash, reservationId, now, expiresAt)
  return reservation === null ? null : { reservation, bytes }
}

/** Finish durable deletion work for one hash before restoring it under a new key. */
const recoverDeletingHash = async (
  ports: TileBlobStores,
  hash: string,
  now: Millis,
): Promise<boolean> => {
  const work = await ports.sql.listTileBlobDeletionWork(INGEST_RECOVERY_LIMIT)
  const deleting = work.filter((object) => object.hash === hash && object.state === 'deleting')
  if (deleting.length === 0) return false
  for (const object of deleting) {
    await reclaimTileBlob(ports, object, now)
  }
  return true
}

/** Reserve an unfenced generation, recovering any interrupted older deletion once if needed. */
export const reserveTileBlobUpload = async (
  ports: TileBlobStores,
  hash: string,
  now = clock(),
): Promise<TileBlobReservation> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reservation = await ports.sql.reserveTileBlobUpload(
      hash,
      generationKey(hash),
      crypto.randomUUID(),
      now,
      reservationWindow(now),
    )
    if (reservation !== null) return reservation
    if (attempt === 0 && (await recoverDeletingHash(ports, hash, now))) continue
    break
  }
  throw new Error(`tile blob ${hash} is fenced by deletion work that could not be recovered`)
}

// Module scope, because concurrent requests in one Worker isolate share nothing else.

/** Tile-object PUTs in flight, by blob key, so concurrent uploaders share one. */
const inFlightTilePuts = new Map<string, Promise<void>>()

/**
 * Blob keys whose bytes this isolate has stored or seen active. A generation stays `uploading`
 * until its owner's observation commits, long after the PUT settled, and every reporter reserving
 * it in that gap would PUT again. `generationKey` never reuses a key, so a remembered key cannot
 * point at reclaimed bytes; forgetting one costs only a state read.
 */
const storedTileBlobKeys = new BoundedCache<true>({ maxEntries: 512 })

/**
 * Store one reserved generation's bytes at most once at a time.
 *
 * Reporters that offer the same fresh hash inside one commit window all reserve the same
 * `uploading` generation, and none of them sees it `active` yet. The first PUT for a key is
 * shared with every concurrent caller; a failed PUT rejects them all so each retries its own.
 */
export const storeTileBlob = async (
  ports: TileBlobStores,
  reservation: TileBlobReservation,
  bytes: Uint8Array,
): Promise<void> => {
  const { hash, blobKey } = reservation
  if (storedTileBlobKeys.get(blobKey) !== undefined) {
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
    const registered = await ports.sql.readTileBlob(hash)
    if (registered?.state === 'active' && registered.blobKey === blobKey) {
      ingestTimings.count('upload.blobPut.skipped')
    } else {
      await ports.blobs.put('tiles', blobKey, bytes)
    }
    storedTileBlobKeys.set(blobKey, true)
  })().finally(() => {
    inFlightTilePuts.delete(blobKey)
  })
  inFlightTilePuts.set(blobKey, work)
  return work
}

/**
 * Advance one bounded R2 sweep and one bounded deletion batch.
 *
 * Candidate rows and the scan cursor persist in dry-run mode, but only `delete` claims a fence or
 * calls R2 deletion. Deleting rows sort first, so every interrupted phase resumes before new work.
 */
export const runTileBlobGc = async (
  ports: TileBlobStores,
  options: {
    readonly mode: TileBlobGcMode
    readonly now?: Millis
    readonly logger?: TileBlobGcLogger
  },
): Promise<TileBlobGcReport> => {
  const now = options.now ?? clock()
  const logger = options.logger ?? console
  const scan = await ports.sql.readTileBlobScanState()
  const page = await ports.blobs.list('tiles', {
    ...(scan.cursor === undefined ? {} : { cursor: scan.cursor }),
    limit: TILE_BLOB_GC_SCAN_LIMIT,
  })
  let candidates = 0
  let referenced = 0
  let invalidKeys = 0
  for (const blobKey of page.keys) {
    const hash = TILE_BLOB_KEY.exec(blobKey)?.[1]
    if (hash === undefined) {
      invalidKeys++
      continue
    }
    const result = await ports.sql.noteTileBlobObject(hash, blobKey, now)
    if (result === 'candidate') candidates++
    else if (result === 'referenced') referenced++
  }
  await ports.sql.writeTileBlobScanState(page.cursor)

  const work = await ports.sql.listTileBlobDeletionWork(TILE_BLOB_GC_DELETE_LIMIT)
  let blocked = 0
  let retries = 0
  let reclaimed = 0
  let failed = 0
  if (options.mode === 'delete') {
    for (const object of work) {
      if (object.state === 'deleting') retries++
      try {
        const result = await reclaimTileBlob(ports, object, now)
        if (result === 'blocked') blocked++
        else if (result === 'reclaimed') reclaimed++
      } catch (error) {
        failed++
        logger.error(
          JSON.stringify({
            event: 'tile_blob_gc_error',
            hash: object.hash,
            blobKey: object.blobKey,
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    }
  }

  const nextScan = await ports.sql.readTileBlobScanState()
  const report: TileBlobGcReport = {
    event: 'tile_blob_gc',
    mode: options.mode,
    scanned: page.keys.length,
    candidates,
    referenced,
    invalidKeys,
    queued: work.length,
    blocked,
    retries,
    reclaimed,
    failed,
    completedSweeps: nextScan.completedSweeps,
    ...(nextScan.cursor === undefined ? {} : { cursor: nextScan.cursor }),
  }
  logger.log(JSON.stringify(report))
  return report
}
