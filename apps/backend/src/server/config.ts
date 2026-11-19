import {
  isUuidV7,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  parseWholeNumber,
} from '@caelestis/shared'
import { ARCHIVE_SETTLE_MILLISECONDS } from '../archive/fence.js'
import { MAX_LIVE_SUBSCRIBERS } from '../live/session.js'
import type { TileBlobGcMode } from '../telemetry/tile-blobs.js'
import { buildId, type Release } from './release.js'

/** The variables every host reads. Worker `Env` and `process.env` both satisfy it. */
export type ServerEnvironment = {
  readonly [Name in
    | 'SEASON'
    | 'OPEN_ACCESS'
    | 'SERVER_ID'
    | 'SERVER_NAME'
    | 'SERVER_DESCRIPTION'
    | 'ADMIN_TOKEN'
    | 'TILE_BLOB_GC_MODE'
    | 'ARCHIVE_SETTLE_SECONDS'
    | 'BASE_PATH'
    | 'SHARD_STRATEGY'
    | 'CAELESTIS_LIVE_SUBSCRIBER_LIMIT']?: string | undefined
}

export interface ServerConfig {
  readonly season: number
  /** Serve the read surface without a token, and advertise `auth: 'none'`. */
  readonly openAccess: boolean
  /** Absent on a host that generates and stores its own id. */
  readonly serverId: string | undefined
  readonly serverName: string
  readonly serverDescription: string | undefined
  /** The operator's bootstrap credential; absent once a real admin token exists. */
  readonly adminToken: string | undefined
  readonly tileGc: TileBlobGcMode
  /** How long a restore waits for cached gate reads to expire before accepting records. */
  readonly archiveSettleMilliseconds: number
  /** Where the host mounts the app, or undefined when it serves the app at the root. */
  readonly basePath: string | undefined
  /** Capacity measurements raise this on an isolated stack; production keeps the default. */
  readonly liveSubscriberLimit: number
  readonly version: string | undefined
  readonly build: string
}

const DEFAULT_SERVER_NAME = 'Caelestis'

/**
 * Parse every setting both hosts share, once, before storage opens or traffic arrives.
 *
 * An empty value means unset: the shipped self-hosted example sets `SERVER_DESCRIPTION = ""`.
 * Anything else that would fail the wire schema later, such as a typo in `SEASON` or an
 * over-long name, is refused here, so the operator hears about it at startup instead of from a
 * client that cannot decode the manifest.
 */
export const parseServerConfig = (env: ServerEnvironment, release: Release = {}): ServerConfig => {
  const read = (name: keyof ServerEnvironment): string | undefined => env[name] || undefined
  const refuse = (name: keyof ServerEnvironment, rule: string): never => {
    throw new Error(`${name} must be ${rule}: ${JSON.stringify(env[name])}`)
  }
  const wholeNumber = (name: keyof ServerEnvironment, fallback: number): number => {
    const value = read(name)
    if (value === undefined) return fallback
    return parseWholeNumber(value) ?? refuse(name, 'a non-negative integer')
  }

  const shardStrategy = read('SHARD_STRATEGY')
  if (shardStrategy !== undefined && shardStrategy !== 'single')
    refuse('SHARD_STRATEGY', '"single"')

  const openAccess = read('OPEN_ACCESS')
  if (openAccess !== undefined && openAccess !== 'true' && openAccess !== 'false')
    refuse('OPEN_ACCESS', 'true or false')

  const serverId = read('SERVER_ID')
  if (serverId !== undefined && !isUuidV7(serverId)) refuse('SERVER_ID', 'a UUIDv7')

  const serverName = read('SERVER_NAME') ?? DEFAULT_SERVER_NAME
  if (serverName.length > MAX_NAME_LENGTH)
    refuse('SERVER_NAME', `at most ${MAX_NAME_LENGTH} characters`)

  const serverDescription = read('SERVER_DESCRIPTION')
  if (serverDescription !== undefined && serverDescription.length > MAX_DESCRIPTION_LENGTH)
    refuse('SERVER_DESCRIPTION', `at most ${MAX_DESCRIPTION_LENGTH} characters`)

  const tileGc = read('TILE_BLOB_GC_MODE') ?? 'dry-run'
  if (tileGc !== 'dry-run' && tileGc !== 'delete')
    return refuse('TILE_BLOB_GC_MODE', 'dry-run or delete')

  const rawBasePath = read('BASE_PATH')
  const basePath = rawBasePath === '/' ? undefined : rawBasePath
  if (
    basePath !== undefined &&
    (!basePath.startsWith('/') || basePath.endsWith('/') || /[?#]/.test(basePath))
  )
    refuse('BASE_PATH', 'an absolute path without a trailing slash')

  const liveSubscriberLimit = wholeNumber('CAELESTIS_LIVE_SUBSCRIBER_LIMIT', MAX_LIVE_SUBSCRIBERS)
  if (liveSubscriberLimit < 1) refuse('CAELESTIS_LIVE_SUBSCRIBER_LIMIT', 'at least 1')

  return {
    season: wholeNumber('SEASON', 0),
    openAccess: openAccess === 'true',
    serverId,
    serverName,
    serverDescription,
    adminToken: read('ADMIN_TOKEN'),
    tileGc,
    archiveSettleMilliseconds:
      read('ARCHIVE_SETTLE_SECONDS') === undefined
        ? ARCHIVE_SETTLE_MILLISECONDS
        : wholeNumber('ARCHIVE_SETTLE_SECONDS', 0) * 1_000,
    basePath,
    liveSubscriberLimit,
    version: release.version,
    build: buildId(release.build),
  }
}
