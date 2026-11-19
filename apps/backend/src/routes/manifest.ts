import { parseWholeNumber, type ServerInfo } from '@caelestis/shared'
import { Hono } from 'hono'
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

    const candidates = (c.req.header('if-none-match') ?? '')
      .split(',')
      .map((candidate) => candidate.trim().replace(/^W\//, ''))
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
        ifNoneMatch: candidates,
        // Only the deployed season owns a bounded Durable Object projection. Historical season
        // reads remain authoritative without materializing attacker-selected shards.
        cacheable: season === options.currentSeason,
      }),
      (projection) => {
        recordCacheOutcome(projection.cacheOutcome)
        const etag = `"${projection.version}"`
        const headers = { ETag: etag, Vary: 'Authorization' }
        // RFC 9110 lets If-None-Match carry a comma-separated list and mark each entry weak with `W/`.
        // An exact string compare therefore missed a conforming client entirely: send two etags, or one
        // a cache has weakened, and you never get a 304 again. Weak comparison is the right one here —
        // the manifest is a content hash, so a weak and a strong tag over the same bytes mean the same.
        return projection.notModified
          ? c.body(null, 304, headers)
          : c.json(projection.manifest, 200, headers)
      },
    )
  })

  return routes
}
