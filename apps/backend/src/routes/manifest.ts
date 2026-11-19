import { parseWholeNumber, type ServerInfo } from '@caelestis/shared'
import { Hono } from 'hono'
import { parseIfNoneMatch } from '../manifest/read-model.js'
import { readManifestProjection } from '../manifest/use-cases.js'
import { recordCacheOutcome } from '../metrics/request-metrics.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import { parseSurface } from './params.js'

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
    if (surface === null) {
      return c.json(
        { error: 'surface must be world or an alliance surface with a positive allianceId' },
        400,
      )
    }

    return runBackendHttp(
      c,
      runtime,
      readManifestProjection({
        // Resolved rather than the configured value: the manifest carries the server's name too, and
        // a rename that showed up on `/server` but not here would leave the tree labelled with the
        // old one — which is exactly where anyone would look to check the rename worked.
        server: options.server,
        season,
        surface,
        includeUnpublished: c.get('caller').canSeeDrafts,
        ifNoneMatch: parseIfNoneMatch(c.req.header('if-none-match')),
        // Only the deployed season owns a bounded Durable Object projection. Historical season
        // reads remain authoritative without materializing attacker-selected shards.
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
