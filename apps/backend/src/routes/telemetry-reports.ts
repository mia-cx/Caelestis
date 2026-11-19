import {
  isSha256Hex,
  MAX_NAME_LENGTH,
  millis,
  parseWholeNumber,
  type StatusDelta,
  seconds,
  WORLD_TILES,
} from '@caelestis/shared'
import {
  MAX_EPOCH_SECONDS,
  MIN_EPOCH_SECONDS,
  PaintEvent,
  TileOfferBatch,
} from '@caelestis/wire-schema'
import { Option, Schema } from 'effect'
import { type Context, Hono } from 'hono'
import { type AuthOptions, requireScopeEffect } from '../auth/middleware.js'
import {
  recordCacheOutcome,
  recordTileOfferBatch,
  recordTileOfferBatchRequested,
} from '../metrics/request-metrics.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { runBackendHttp } from '../runtime/hono.js'
import type { StatusProjectionChange } from '../status-read-model/model.js'
import { MAX_CANVAS_TILE_BYTES, offerTiles, uploadTile } from '../telemetry/ingest.js'
import { recordPaint } from '../telemetry/paint.js'
import type { TelemetryRouteOptions } from './telemetry.js'

/** A reply carries its status delta only while it stays small; a client reconciles otherwise. */
const MAX_MUTATION_STATUS_BYTES = 32 * 1024
const MAX_TILE_OFFER_BODY_BYTES = 64 * 1024

/** The caller's view of a projection change, when it is small enough to send inline. */
const mutationStatus = (
  c: Context,
  projection: StatusProjectionChange | null,
): StatusDelta | undefined => {
  const status = projection?.[c.get('caller').scope === 'admin' ? 'admin' : 'public']
  return status !== undefined &&
    new TextEncoder().encode(JSON.stringify(status)).byteLength <= MAX_MUTATION_STATUS_BYTES
    ? status
    : undefined
}

const decodedHeader = (value: string | undefined): string | null => {
  if (value === undefined) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

const readBoundedBody = async (request: Request, limit: number): Promise<Uint8Array | null> => {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) return null
  if (request.body === null) return null
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > limit) {
        await reader.cancel()
        return null
      }
      parts.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.byteLength
  }
  return bytes
}

const parseJson = (bytes: Uint8Array | null): unknown => {
  if (bytes === null) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

/** Reporter writes: tile offers, tile uploads, and paint events. */
export const createTelemetryReportRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  options: TelemetryRouteOptions,
) => {
  const routes = new Hono()
  const report = requireScopeEffect(runtime, auth, 'report')

  routes.post('/tiles/offers', report, async (c) => {
    const body = Option.getOrNull(
      Schema.decodeUnknownOption(TileOfferBatch)(
        parseJson(await readBoundedBody(c.req.raw, MAX_TILE_OFFER_BODY_BYTES)),
      ),
    )
    if (body === null) return c.json({ error: 'invalid tile offer batch' }, 400)
    if (body.season !== options.currentSeason) {
      return c.json({ error: 'season is not served by this telemetry endpoint' }, 400)
    }
    recordTileOfferBatchRequested(body.offers.length)
    const caller = c.get('caller')
    return runBackendHttp(
      c,
      runtime,
      offerTiles({
        season: body.season,
        reporter: {
          wplaceUserId: body.wplaceUserId,
          displayName: body.displayName,
          tokenHash: caller.tokenHash,
        },
        includeUnpublished: caller.scope === 'admin',
        offers: body.offers,
      }),
      (result) => {
        recordCacheOutcome(result.cacheOutcome)
        recordTileOfferBatch({
          requested: body.offers.length,
          accepted: result.wanted.length,
          alreadyKnown: result.acknowledged.length,
          rejected: result.rejected.length,
        })
        const status = mutationStatus(c, result.projection)
        return c.json({
          wanted: result.wanted,
          acknowledged: result.acknowledged,
          rejected: result.rejected,
          ...(result.coverageToken === undefined ? {} : { coverageToken: result.coverageToken }),
          ...(status === undefined ? {} : { status }),
        })
      },
    )
  })

  routes.put('/tiles/:x/:y/:hash', report, async (c) => {
    const x = parseWholeNumber(c.req.param('x'))
    const y = parseWholeNumber(c.req.param('y'))
    const hash = c.req.param('hash')
    const season = parseWholeNumber(c.req.header('x-caelestis-season'))
    const observedAt = parseWholeNumber(c.req.header('x-caelestis-observed-at'))
    const wplaceUserId = parseWholeNumber(c.req.header('x-caelestis-wplace-user-id'))
    const displayName = decodedHeader(c.req.header('x-caelestis-display-name'))
    if (
      x === null ||
      y === null ||
      x >= WORLD_TILES ||
      y >= WORLD_TILES ||
      !isSha256Hex(hash) ||
      season === null ||
      season !== options.currentSeason ||
      observedAt === null ||
      observedAt < MIN_EPOCH_SECONDS ||
      observedAt > MAX_EPOCH_SECONDS ||
      wplaceUserId === null ||
      displayName === null ||
      displayName.length === 0 ||
      displayName.length > MAX_NAME_LENGTH
    ) {
      return c.json({ error: 'invalid tile metadata' }, 400)
    }
    const bytes = await readBoundedBody(c.req.raw, MAX_CANVAS_TILE_BYTES)
    if (bytes === null) return c.json({ error: 'invalid tile body' }, 400)
    const caller = c.get('caller')
    return runBackendHttp(
      c,
      runtime,
      uploadTile(
        {
          wplaceUserId,
          displayName,
          tokenHash: caller.tokenHash,
          season,
          tile: { x, y },
          hash,
          observedAt: seconds(observedAt),
          includeUnpublished: caller.scope === 'admin',
        },
        bytes,
      ),
      (projection) => {
        const status = mutationStatus(c, projection)
        return c.json(status === undefined ? {} : { status })
      },
    )
  })

  routes.post('/paints', report, async (c) => {
    const event = Option.getOrNull(
      Schema.decodeUnknownOption(PaintEvent)(await c.req.json().catch(() => null)),
    )
    if (event === null) return c.json({ error: 'invalid paint event' }, 400)
    const caller = c.get('caller')
    return runBackendHttp(
      c,
      runtime,
      recordPaint(event, caller.tokenHash, caller.scope === 'admin'),
      (result) =>
        result === 'duplicate'
          ? c.json({ accepted: false, duplicate: true })
          : c.json({
              accepted: true,
              partial: result === 'partial',
              receivedAt: millis(Date.now()),
            }),
    )
  })

  return routes
}
