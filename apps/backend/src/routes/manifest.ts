import { parseWholeNumber, type ServerInfo } from '@caelestis/shared'
import { Hono } from 'hono'
import { parseIfNoneMatch } from '../manifest/read-model.js'
import { readManifestProjection } from '../manifest/use-cases.js'
import { recordCacheOutcome } from '../metrics/request-metrics.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import { invalidSurface, parseSurface } from './params.js'

export const createManifestRoutes = (
  runtime: BackendRuntime,
  options: { readonly server: ServerInfo; readonly currentSeason: number },
) => {
  const routes = new Hono()

  routes.get('/', async (c) => {
    const season =
      c.req.query('season') === undefined
        ? options.currentSeason
        : parseWholeNumber(c.req.query('season'))
    if (season === null) return c.json({ error: 'season must be a non-negative integer' }, 400)
    const surface = parseSurface(c.req.query('surface'), c.req.query('allianceId'))
    if (surface === null) return c.json({ error: invalidSurface('surface') }, 400)

    return runBackendHttp(
      c,
      runtime,
      readManifestProjection({
        // The deployment's identity; the read applies an admin's rename over it, so the manifest
        // names the server exactly as `/server` does.
        server: options.server,
        season,
        surface,
        includeUnpublished: c.get('caller').canSeeDrafts,
        ifNoneMatch: parseIfNoneMatch(c.req.header('if-none-match')),
        // Only the deployed season has a cached projection. Earlier seasons are assembled from the
        // database, so a caller cannot make the server materialize a shard per season it names.
        cacheable: season === options.currentSeason,
      }),
      (projection) => {
        recordCacheOutcome(projection.cacheOutcome)
        const etag = `"${projection.version}"`
        const headers = { ETag: etag, Vary: 'Authorization' }
        return projection.notModified
          ? c.body(null, 304, headers)
          : c.json(projection.manifest, 200, headers)
      },
    )
  })

  return routes
}
