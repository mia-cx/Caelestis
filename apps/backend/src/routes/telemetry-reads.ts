import {
  isUuidV7,
  parseWholeNumber,
  type Seconds,
  type ServerInfo,
  seconds,
  WORLD_TILES,
} from '@caelestis/shared'
import { MAX_EPOCH_SECONDS, MAX_PAINTER_TOTALS } from '@caelestis/wire-schema'
import { type Context, Hono } from 'hono'
import { type AuthOptions, requireScopeEffect } from '../auth/middleware.js'
import { MAX_IDS_PER_READ } from '../db/d1-limits.js'
import { matchesIfNoneMatch, parseIfNoneMatch } from '../manifest/read-model.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import { readMismatchMask } from '../telemetry/classification.js'
import { MAX_PAINTER_HISTORY_IDS } from '../telemetry/history/store.js'
import { LADDER_RESOLUTIONS, TILE_HISTORY_RESOLUTIONS } from '../telemetry/ladder.js'
import { readVisibleProgressHistory } from '../telemetry/progress-history.js'
import {
  readAlarms,
  readCanvas,
  readContributions,
  readHistory,
  readLeaderboard,
  readPainterHistory,
  readPainterTotals,
  readStatus,
  readTileHistory,
} from '../telemetry/queries.js'

export interface TelemetryRouteOptions {
  readonly currentSeason: number
  /** Names the current season's cached manifest, which tile-history visibility reuses. */
  readonly server?: ServerInfo
}

/** Larger leaderboards stop being leaderboards; page by narrowing the window instead. */
const MAX_LEADERBOARD_LIMIT = 200
const DEFAULT_LEADERBOARD_LIMIT = 50

const SEASON_ERROR = 'season must be a non-negative integer'
const TEMPLATE_IDS_ERROR = `templateIds must be 1..${MAX_IDS_PER_READ} comma-separated ids`
const RANGE_ERROR = 'from and to must be Unix seconds with from < to'
const MAX_RESOLUTION_ERROR = `maxResolution must be at least ${LADDER_RESOLUTIONS[0]}`

/** Comma-separated template ids, validated per id and bounded by the port's read cap. */
const parseTemplateIds = (value: string | undefined): string[] | null => {
  if (value === undefined || value.length === 0) return null
  const ids = value.split(',')
  if (ids.length > MAX_IDS_PER_READ) return null
  return ids.every(isUuidV7) ? ids : null
}

const parsePainterIds = (value: string | undefined): number[] | null => {
  if (value === undefined || value.length === 0) return null
  const ids: number[] = []
  for (const text of value.split(',')) {
    const id = parseWholeNumber(text)
    if (id === null) return null
    ids.push(id)
  }
  return ids.length > MAX_PAINTER_HISTORY_IDS ? null : [...new Set(ids)]
}

/**
 * A half-open `[from, to)` range in Unix seconds. `to <= from` is refused rather than answered with
 * an empty array, because it is always a caller bug — a swapped pair, or a window computed from a
 * clock that went backwards — and an empty chart hides it where a 400 names it.
 */
const parseRange = (
  c: Context,
): { readonly fromSeconds: Seconds; readonly toSeconds: Seconds } | null => {
  const from = parseWholeNumber(c.req.query('from'))
  const to = parseWholeNumber(c.req.query('to'))
  if (from === null || to === null) return null
  if (to <= from || to > MAX_EPOCH_SECONDS) return null
  return { fromSeconds: seconds(from), toSeconds: seconds(to) }
}

const optionalWholeNumber = (value: string | undefined): number | undefined | null =>
  value === undefined ? undefined : parseWholeNumber(value)

/** Validate an optional `maxResolution`: absent, at least the finest ladder tier, or null. */
const parseMaxResolution = (c: Context): number | undefined | null => {
  const maxResolution = optionalWholeNumber(c.req.query('maxResolution'))
  return maxResolution !== null &&
    maxResolution !== undefined &&
    maxResolution < (LADDER_RESOLUTIONS[0] ?? 0)
    ? null
    : maxResolution
}

const etagMatches = (c: Context, version: string): boolean =>
  matchesIfNoneMatch(parseIfNoneMatch(c.req.header('if-none-match')), version)

const includeUnpublished = (c: Context): boolean => c.get('caller').scope === 'admin'

export const createTelemetryReadRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  options: TelemetryRouteOptions,
) => {
  const routes = new Hono()
  const read = requireScopeEffect(runtime, auth, 'read')
  /** The `season` query, or the current season when absent; null when malformed. */
  const seasonOf = (c: Context): number | null =>
    c.req.query('season') === undefined
      ? options.currentSeason
      : parseWholeNumber(c.req.query('season'))

  routes.get('/status', read, async (c) => {
    const season = seasonOf(c)
    if (season === null) return c.json({ error: SEASON_ERROR }, 400)
    return runBackendHttp(
      c,
      runtime,
      readStatus(season, includeUnpublished(c), season === options.currentSeason),
      ({ response, version }) => {
        if (version === null) return c.json(response)
        const headers = { ETag: `"${version}"`, Vary: 'Authorization' }
        return etagMatches(c, version) ? c.body(null, 304, headers) : c.json(response, 200, headers)
      },
    )
  })

  routes.get('/alarms', read, async (c) => {
    const season = seasonOf(c)
    if (season === null) return c.json({ error: SEASON_ERROR }, 400)
    return runBackendHttp(c, runtime, readAlarms(season, includeUnpublished(c)), (response) =>
      c.json(response),
    )
  })

  routes.get(
    '/templates/:templateId/versions/:versionId/tiles/:x/:y/mismatches',
    read,
    async (c) => {
      const templateId = c.req.param('templateId')
      const versionId = c.req.param('versionId')
      const x = parseWholeNumber(c.req.param('x'))
      const y = parseWholeNumber(c.req.param('y'))
      const season = seasonOf(c)
      if (
        !isUuidV7(templateId) ||
        !isUuidV7(versionId) ||
        x === null ||
        y === null ||
        x >= WORLD_TILES ||
        y >= WORLD_TILES ||
        season === null
      ) {
        return c.json({ error: 'template, version, tile and season must be valid' }, 400)
      }
      return runBackendHttp(
        c,
        runtime,
        readMismatchMask({
          season,
          templateId,
          versionId,
          tile: { x, y },
          includeUnpublished: includeUnpublished(c),
        }),
        (result) => {
          if (result.kind === 'not-found') return c.json({ error: 'template tile not found' }, 404)
          if (result.kind === 'unobserved') return c.body(null, 204)
          // A content hash, so a client revalidating the mask it holds downloads nothing when every
          // paint since landed elsewhere. Weak and strong tags over the same bytes mean the same.
          const headers = { etag: `"${result.hash}"`, 'cache-control': 'no-store' }
          if (etagMatches(c, result.hash)) return c.body(null, 304, headers)
          return c.body(new Uint8Array(result.bytes), 200, {
            ...headers,
            'content-type': 'application/vnd.caelestis.mismatch-mask',
          })
        },
      )
    },
  )

  routes.get('/progress/:templateId', read, async (c) => {
    const id = c.req.param('templateId')
    const versionId = c.req.query('version')
    const range = parseRange(c)
    if (!isUuidV7(id) || (versionId !== undefined && !isUuidV7(versionId)) || range === null)
      return c.json({ error: 'Choose a template, optional version, and valid time range.' }, 400)
    return runBackendHttp(
      c,
      runtime,
      readVisibleProgressHistory(id, versionId, range, includeUnpublished(c)),
      (response) => c.json(response),
    )
  })

  routes.get('/history', read, async (c) => {
    const templateIds = parseTemplateIds(c.req.query('templateIds'))
    if (templateIds === null) return c.json({ error: TEMPLATE_IDS_ERROR }, 400)
    const requestedResolution = c.req.query('resolution')
    const legacyResolution = optionalWholeNumber(requestedResolution)
    if (
      legacyResolution === null ||
      (legacyResolution !== undefined && !LADDER_RESOLUTIONS.includes(legacyResolution))
    ) {
      return c.json({ error: `resolution must be one of ${LADDER_RESOLUTIONS.join(', ')}` }, 400)
    }
    const maxResolution = parseMaxResolution(c)
    if (maxResolution === null) return c.json({ error: MAX_RESOLUTION_ERROR }, 400)
    if (legacyResolution !== undefined && maxResolution !== undefined) {
      return c.json({ error: 'resolution and maxResolution cannot be combined' }, 400)
    }
    const range = parseRange(c)
    if (range === null) return c.json({ error: RANGE_ERROR }, 400)
    return runBackendHttp(
      c,
      runtime,
      readHistory({
        templateIds,
        range,
        legacyResolution,
        maxResolution,
        includeUnpublished: includeUnpublished(c),
      }),
      (response) => c.json(response),
    )
  })

  routes.get('/painter-history', read, async (c) => {
    const templateIds = parseTemplateIds(c.req.query('templateIds'))
    if (templateIds === null) return c.json({ error: TEMPLATE_IDS_ERROR }, 400)
    const maxResolution = parseMaxResolution(c)
    if (maxResolution === null) return c.json({ error: MAX_RESOLUTION_ERROR }, 400)
    const range = parseRange(c)
    if (range === null) return c.json({ error: RANGE_ERROR }, 400)
    // Named painters only: the response is bounded by who is drawn, whatever the scope's age.
    const wplaceUserIds = parsePainterIds(c.req.query('painters'))
    if (wplaceUserIds === null) {
      return c.json(
        { error: `painters must be 1..${MAX_PAINTER_HISTORY_IDS} comma-separated wplace user ids` },
        400,
      )
    }
    return runBackendHttp(
      c,
      runtime,
      readPainterHistory({
        templateIds,
        wplaceUserIds,
        range,
        maxResolution,
        includeUnpublished: includeUnpublished(c),
      }),
      (response) => c.json(response),
    )
  })

  routes.get('/painters', read, async (c) => {
    const templateIds = parseTemplateIds(c.req.query('templateIds'))
    if (templateIds === null) return c.json({ error: TEMPLATE_IDS_ERROR }, 400)
    const range = parseRange(c)
    if (range === null) return c.json({ error: RANGE_ERROR }, 400)
    const limit = optionalWholeNumber(c.req.query('limit')) ?? MAX_PAINTER_TOTALS
    if (limit === null || limit < 1) {
      return c.json({ error: 'limit must be a positive integer' }, 400)
    }
    return runBackendHttp(
      c,
      runtime,
      readPainterTotals({
        templateIds,
        range,
        limit: Math.min(limit, MAX_PAINTER_TOTALS),
        includeUnpublished: includeUnpublished(c),
      }),
      (response) => c.json(response),
    )
  })

  routes.get('/contributions', read, async (c) => {
    const templateIds = parseTemplateIds(c.req.query('templateIds'))
    if (templateIds === null) return c.json({ error: TEMPLATE_IDS_ERROR }, 400)
    const range = parseRange(c)
    if (range === null) return c.json({ error: RANGE_ERROR }, 400)
    return runBackendHttp(
      c,
      runtime,
      readContributions({ templateIds, range, includeUnpublished: includeUnpublished(c) }),
      (response) => c.json(response),
    )
  })

  routes.get('/leaderboard', read, async (c) => {
    const season = seasonOf(c)
    if (season === null) return c.json({ error: SEASON_ERROR }, 400)
    const rawTemplateIds = c.req.query('templateIds')
    const templateIds = rawTemplateIds === undefined ? undefined : parseTemplateIds(rawTemplateIds)
    if (templateIds === null) return c.json({ error: TEMPLATE_IDS_ERROR }, 400)
    const from = optionalWholeNumber(c.req.query('from'))
    const to = optionalWholeNumber(c.req.query('to'))
    if (from === null || to === null || (from !== undefined && to !== undefined && to <= from)) {
      return c.json({ error: RANGE_ERROR }, 400)
    }
    const limit = optionalWholeNumber(c.req.query('limit')) ?? DEFAULT_LEADERBOARD_LIMIT
    if (limit === null || limit < 1 || limit > MAX_LEADERBOARD_LIMIT) {
      return c.json({ error: `limit must be 1..${MAX_LEADERBOARD_LIMIT}` }, 400)
    }
    return runBackendHttp(
      c,
      runtime,
      readLeaderboard({
        season,
        templateIds,
        from: from === undefined ? undefined : seconds(from),
        to: to === undefined ? undefined : seconds(to),
        limit,
        includeUnpublished: includeUnpublished(c),
      }),
      (response) => c.json(response),
    )
  })

  routes.get('/canvas', read, async (c) => {
    const season = seasonOf(c)
    if (season === null) return c.json({ error: SEASON_ERROR }, 400)
    return runBackendHttp(c, runtime, readCanvas(season, includeUnpublished(c)), (response) =>
      c.json(response),
    )
  })

  // GET here, PUT with a trailing `:hash` in the report routes. Hono matches on method and path
  // together, so the two never collide, and `history` is not a valid hash either.
  routes.get('/tiles/:x/:y/history', read, async (c) => {
    const x = parseWholeNumber(c.req.param('x'))
    const y = parseWholeNumber(c.req.param('y'))
    if (x === null || y === null || x >= WORLD_TILES || y >= WORLD_TILES) {
      return c.json({ error: 'tile coordinates must be on the canvas' }, 400)
    }
    const season = seasonOf(c)
    if (season === null) return c.json({ error: SEASON_ERROR }, 400)
    const legacyResolution = optionalWholeNumber(c.req.query('resolution'))
    if (
      legacyResolution === null ||
      (legacyResolution !== undefined && !TILE_HISTORY_RESOLUTIONS.includes(legacyResolution))
    ) {
      return c.json(
        { error: `resolution must be one of ${TILE_HISTORY_RESOLUTIONS.join(', ')}` },
        400,
      )
    }
    const range = parseRange(c)
    if (range === null) return c.json({ error: RANGE_ERROR }, 400)
    return runBackendHttp(
      c,
      runtime,
      readTileHistory({
        season,
        tile: { x, y },
        range,
        legacyResolution,
        includeUnpublished: includeUnpublished(c),
        // Only the deployed season owns a cached manifest; earlier seasons read the database.
        server: season === options.currentSeason ? options.server : undefined,
      }),
      (response) => c.json(response),
    )
  })

  return routes
}
