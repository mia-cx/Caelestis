import { type ServerAssetKind, type ServerInfo, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { Effect } from 'effect'
import type { ServerAssetRecord, ServerSettings, SqlStore } from '../ports/sql-store.js'
import {
  BlobStoreService,
  PresenceService,
  SqlStoreService,
  StatusReadModelService,
} from '../runtime/backend-runtime.js'
import { NotFoundError, type StorageError, storage } from '../runtime/errors.js'
import { mergeServerInfo, serverAssetInfo } from '../server-info.js'
import { publishManifestChange } from '../status-read-model/port.js'
import { ingestTimings } from '../telemetry/ingest-timing.js'

const readServerSettings: Effect.Effect<ServerSettings, StorageError, SqlStoreService> = Effect.gen(
  function* () {
    const sql = yield* SqlStoreService
    return yield* storage('readServerSettings', () => sql.readServerSettings())
  },
)

/**
 * What this server calls itself, as the deployment configured it and an admin has since renamed it.
 *
 * Resolved per request rather than fixed at start-up, because a rename has to take effect without a
 * redeploy. The deployment's vars stay the value a fresh server begins with; anything set here wins
 * for as long as it is set.
 */
export const resolveServerInfo = (
  base: ServerInfo,
): Effect.Effect<ServerInfo, StorageError, SqlStoreService> =>
  Effect.map(readServerSettings, (settings) => mergeServerInfo(base, settings))

/** Persist a partial operator override without changing omitted fields, then tell manifest readers. */
export const writeServerSettings = (
  settings: Parameters<SqlStore['writeServerSettings']>[0],
  season: number,
): Effect.Effect<void, StorageError, SqlStoreService | StatusReadModelService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    yield* storage('writeServerSettings', () => sql.writeServerSettings(settings))
    const statusReadModel = yield* StatusReadModelService
    yield* Effect.promise(() => publishManifestChange(statusReadModel, season))
  })

/** A branding asset's bytes and public identity. */
export const readServerAsset = (kind: ServerAssetKind) =>
  Effect.gen(function* () {
    const missing = Effect.fail(new NotFoundError({ message: 'asset not found' }))
    const record = (yield* readServerSettings)[kind]
    if (record === null) return yield* missing
    const blobs = yield* BlobStoreService
    const bytes = yield* storage('getServerAsset', () => blobs.get('branding', record.blobKey))
    if (bytes === null) return yield* missing
    return { bytes, ...serverAssetInfo(record) }
  })

/**
 * Store a replacement (or clear the asset), then drop whatever the settings no longer reference.
 *
 * Branding is never swept, so every object this leaves behind is leaked for good. One rule keeps
 * that bounded: after our write, delete exactly the objects the settings no longer reference. That
 * covers the old object (unless an overlapping upload restored it), our own object when an
 * overlapping upload superseded it, and a settings write that failed after the store.
 */
export const replaceServerAsset = (
  kind: ServerAssetKind,
  record: ServerAssetRecord | null,
  bytes: Uint8Array | null,
  season: number,
) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStoreService
    const deleteBlob = (key: string) =>
      storage('deleteServerAsset', () => blobs.delete('branding', [key]))
    const previous = (yield* readServerSettings)[kind]
    // Re-uploading identical bytes overwrites the object the settings already reference; that one
    // must survive a failed write.
    const storedFresh = record !== null && bytes !== null && previous?.blobKey !== record.blobKey
    if (record !== null && bytes !== null) {
      yield* storage('putServerAsset', () => blobs.put('branding', record.blobKey, bytes))
    }
    yield* writeServerSettings({ [kind]: record }, season).pipe(
      Effect.tapError(() =>
        storedFresh && record !== null ? Effect.ignore(deleteBlob(record.blobKey)) : Effect.void,
      ),
    )
    const current = (yield* readServerSettings)[kind]
    if (previous !== null && current?.blobKey !== previous.blobKey) {
      yield* deleteBlob(previous.blobKey)
    }
    if (storedFresh && record !== null && current?.blobKey !== record.blobKey) {
      yield* deleteBlob(record.blobKey)
    }
  })

/**
 * Where live uploads, offers, and paints spend their time since the last reset. Live commands
 * run in the current season's coordinator, which on Cloudflare is a Durable Object rather than
 * this Worker, so ask the read model when it can reach that context.
 */
export const readIngestTimings = (season: number, reset: boolean) =>
  Effect.gen(function* () {
    const statusReadModel = yield* StatusReadModelService
    const readCoordinator = statusReadModel.readIngestTimings?.bind(statusReadModel)
    const snapshot =
      readCoordinator === undefined
        ? ingestTimings.snapshot()
        : yield* Effect.promise(() => readCoordinator(season, reset))
    if (reset && readCoordinator === undefined) ingestTimings.reset()
    const presence = yield* PresenceService
    const readRoom = presence.readIngestTimings?.bind(presence)
    if (readRoom === undefined) return snapshot
    // A presence Durable Object has its own isolate and clock. The admin endpoint covers the
    // current season's world room explicitly, rather than returning another isolate's zeros.
    const room = yield* Effect.promise(() => readRoom(season, WORLD_TEMPLATE_SURFACE, reset))
    return {
      ...snapshot,
      commands: {
        ...snapshot.commands,
        presence: room.commands.presence,
        claims: room.commands.claims,
      },
      presenceRoom: { season, surface: WORLD_TEMPLATE_SURFACE, since: room.since },
    }
  })
