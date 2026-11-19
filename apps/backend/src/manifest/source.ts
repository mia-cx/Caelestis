import type { Manifest } from '@caelestis/shared'
import { mergeServerInfo } from '../server/info.js'
import type { ServerSettingsStore } from '../server/store.js'
import { assembleManifest, type ManifestStores } from './assemble.js'
import { type ManifestProjectionInput, seesUnpublished } from './read-model.js'

/** Authoritative manifest source used by both portable and Durable Object read models. */
export const assembleManifestProjection = async (
  sql: ManifestStores & ServerSettingsStore,
  input: ManifestProjectionInput,
): Promise<Manifest> => {
  const server = mergeServerInfo(input.server, await sql.readServerSettings())
  return assembleManifest(sql, {
    server,
    season: input.season,
    surface: input.surface,
    includeUnpublished: seesUnpublished(input.scope),
  })
}
