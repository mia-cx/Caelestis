import { R2ObjectStorage } from '@caelestis/storage/r2'
import { instrumentD1 } from '../../metrics/request-metrics.js'
import { type PresenceRooms, presenceRoomName } from '../../presence/port.js'
import { parseServerConfig, type ServerConfig } from '../../server/config.js'
import { bundledRelease } from '../../server/release.js'
import { portableStores } from '../../server/stores.js'
import { CoordinatedStatusReadModel } from '../../status-read-model/shard.js'
import { d1Connection } from './d1-connection.js'
import { durableCounters } from './do-counter-store.js'
import { durableStatusShards } from './do-status-read-model.js'
import { forwardPresence } from './live-connect.js'

const configs = new WeakMap<Env, ServerConfig & { readonly serverId: string }>()

/** This deployment's settings, parsed once per Worker or Durable Object environment. */
export const cloudflareConfig = (env: Env) => {
  const held = configs.get(env)
  if (held !== undefined) return held
  const config = parseServerConfig(env, bundledRelease)
  const { serverId } = config
  // A Worker has nowhere to keep a generated id across isolates; wrangler.toml names it.
  if (serverId === undefined) throw new Error('SERVER_ID is required on Cloudflare')
  const parsed = { ...config, serverId }
  configs.set(env, parsed)
  return parsed
}

/** The one alarm watcher, which holds the wakeup for durable probes. */
export const alarmWatcher = (env: Env) => env.ALARM_WATCHER.getByName('global')

/**
 * The database, object storage, the stores over them, and the coordinators behind their Durable
 * Objects, as the Worker and every object reach them.
 */
export const cloudflareBindings = (env: Env) => {
  const connection = d1Connection(instrumentD1(env.DB))
  const objects = new R2ObjectStorage(env.BLOBS)
  return {
    connection,
    objects,
    stores: portableStores(connection, objects),
    counters: durableCounters(env.TELEMETRY),
    statusShard: durableStatusShards(env.STATUS_READ_MODEL),
  }
}

/** The stores a Durable Object writes through. Status reads go to each season's object. */
export const cloudflareStores = (env: Env) => {
  const { stores, counters, statusShard } = cloudflareBindings(env)
  return { ...stores, counters, statusReadModel: new CoordinatedStatusReadModel(statusShard) }
}

/** Each presence room's Durable Object, addressed by season and surface. */
export const durablePresenceRooms =
  (env: Env): PresenceRooms =>
  (season, surface) => {
    const room = env.PRESENCE.getByName(presenceRoomName(season, surface))
    return {
      publishRegions: () => room.publishRegions(),
      readIngestTimings: (reset) => room.readIngestTimings(reset),
      online: () => room.online(),
      closeCredential: (tokenHash) => room.closeCredential(tokenHash),
      connect: (connection, request) => forwardPresence(room, request, connection),
    }
  }
