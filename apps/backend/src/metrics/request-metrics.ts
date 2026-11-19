import { AsyncLocalStorage } from 'node:async_hooks'
import { parseClientMetricsAccept } from '@caelestis/shared'
import { buildId, bundledRelease } from '../server/release.js'

export type CacheOutcome = 'none' | 'hit' | 'miss' | 'stale'
export type TileOfferBatchOutcome =
  | 'none'
  | 'requested'
  | 'accepted'
  | 'already-known'
  | 'rejected'
  | 'failed'

export interface TileOfferCounts {
  readonly requested: number
  readonly accepted: number
  readonly alreadyKnown: number
  readonly rejected: number
}

/** The D1 work a request or a Durable Object call did. */
export interface D1Usage {
  rowsRead: number
  rowsWritten: number
  measuredQueries: number
  unmeasuredQueries: number
}

const noD1Usage = (): D1Usage => ({
  rowsRead: 0,
  rowsWritten: 0,
  measuredQueries: 0,
  unmeasuredQueries: 0,
})

interface RequestMetricState {
  readonly route: string
  readonly method: string
  readonly client: string
  readonly clientVersion: string
  readonly syncTransport: string
  readonly reconciliationReason: string
  cacheOutcome: CacheOutcome
  tileOfferOutcome: TileOfferBatchOutcome
  tileOfferCounts: TileOfferCounts
  readonly d1: D1Usage
}

export type MeasuredD1Operation<A> =
  | {
      readonly success: true
      readonly value: A
      readonly usage: Readonly<D1Usage>
    }
  | {
      readonly success: false
      readonly error: unknown
      readonly usage: Readonly<D1Usage>
    }

type MetricDataset = Pick<AnalyticsEngineDataset, 'writeDataPoint'>

export interface MetricClientIdentity {
  readonly client: string
  readonly clientVersion: string
}

const requestMetricStorage = new AsyncLocalStorage<RequestMetricState>()
const d1UsageStorage = new AsyncLocalStorage<D1Usage>()
const deploymentVersion = buildId(bundledRelease.build)
// The deploy workflow defines the released userscript versions. Any other build knows none, so
// every userscript version reads as `unknown`.
const userscriptVersions = new Set<string>(
  typeof __CAELESTIS_USERSCRIPT_VERSIONS__ === 'object' ? __CAELESTIS_USERSCRIPT_VERSIONS__ : [],
)

/** Collapse caller-controlled client labels before they become metric dimensions. */
export const normalizeMetricClientIdentity = (
  client: string,
  version: string,
): MetricClientIdentity => {
  const normalizedClient =
    client === 'userscript' || client === 'frontend' || client === 'third-party'
      ? client
      : 'unknown'
  return {
    client: normalizedClient,
    clientVersion:
      (normalizedClient === 'userscript' && userscriptVersions.has(version)) ||
      (normalizedClient === 'frontend' && version === deploymentVersion)
        ? version
        : 'unknown',
  }
}

const route = (method: string, pattern: string): string => `${method} ${pattern}`
const TILE_OFFERS_PATH = '/telemetry/tiles/offers'
const metricMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const normalizeMetricMethod = (method: string): string => {
  const normalized = method.toUpperCase()
  return metricMethods.has(normalized) ? normalized : 'OTHER'
}
const exactRoutes = new Set([
  '/health',
  '/server',
  '/manifest',
  '/admin/server',
  '/admin/tokens',
  '/admin/nodes',
  '/admin/templates',
  '/telemetry/status',
  '/telemetry/alarms',
  '/telemetry/history',
  '/telemetry/contributions',
  '/telemetry/leaderboard',
  '/telemetry/canvas',
  '/telemetry/live',
  TILE_OFFERS_PATH,
  '/telemetry/paints',
])

const unversionedMetricPath = (pathname: string): string =>
  pathname.startsWith('/v1/') && pathname !== '/v1/health' ? pathname.slice('/v1'.length) : pathname

/** A finite route vocabulary: request paths containing ids, hashes, or tokens never reach metrics. */
export const normalizeMetricRoute = (method: string, pathname: string): string => {
  const verb = normalizeMetricMethod(method)
  pathname = unversionedMetricPath(pathname)
  if (verb === 'OTHER') return route(verb, 'other')
  if (exactRoutes.has(pathname)) return route(verb, pathname)
  if (/^\/admin\/tokens\/[^/]+$/.test(pathname)) return route(verb, '/admin/tokens/:tokenHash')
  if (/^\/admin\/nodes\/[^/]+\/subtree$/.test(pathname))
    return route(verb, '/admin/nodes/:id/subtree')
  if (/^\/admin\/nodes\/[^/]+$/.test(pathname)) return route(verb, '/admin/nodes/:id')
  if (/^\/admin\/templates\/[^/]+\/versions$/.test(pathname))
    return route(verb, '/admin/templates/:id/versions')
  if (/^\/admin\/templates\/[^/]+$/.test(pathname)) return route(verb, '/admin/templates/:id')
  if (/^\/chunks\/[^/]+$/.test(pathname)) return route(verb, '/chunks/:hash')
  if (/^\/tiles\/[^/]+$/.test(pathname)) return route(verb, '/tiles/:hash')
  if (/^\/telemetry\/tiles\/[^/]+\/[^/]+\/history$/.test(pathname))
    return route(verb, '/telemetry/tiles/:x/:y/history')
  if (/^\/telemetry\/tiles\/[^/]+\/[^/]+\/[^/]+$/.test(pathname))
    return route(verb, '/telemetry/tiles/:x/:y/:hash')
  if (
    /^\/telemetry\/templates\/[^/]+\/versions\/[^/]+\/tiles\/[^/]+\/[^/]+\/mismatches$/.test(
      pathname,
    )
  )
    return route(
      verb,
      '/telemetry/templates/:templateId/versions/:versionId/tiles/:x/:y/mismatches',
    )
  return route(verb, 'other')
}

const isTileOfferRoute = (state: RequestMetricState): boolean =>
  state.route === route('POST', TILE_OFFERS_PATH)

/** The route a live tile-offer-cache command is recorded under. */
const TILE_OFFER_CACHE_ROUTE = 'WS /telemetry/live:tile-offer-cache'

const isTileOfferMetric = (state: RequestMetricState): boolean =>
  isTileOfferRoute(state) || state.route === TILE_OFFER_CACHE_ROUTE

const finiteCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

const addD1Usage = (into: D1Usage, delta: Partial<D1Usage>): void => {
  into.rowsRead += finiteCount(delta.rowsRead)
  into.rowsWritten += finiteCount(delta.rowsWritten)
  into.measuredQueries += finiteCount(delta.measuredQueries)
  into.unmeasuredQueries += finiteCount(delta.unmeasuredQueries)
}

/** Count D1 work toward the current request's metric and the Durable Object call measuring it. */
const recordD1Usage = (delta: Partial<D1Usage>): void => {
  const state = requestMetricStorage.getStore()
  if (state !== undefined) addD1Usage(state.d1, delta)
  const usage = d1UsageStorage.getStore()
  if (usage !== undefined) addD1Usage(usage, delta)
}

const recordD1Rows = (result: D1Result): void =>
  recordD1Usage({ rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written })

/** Collect D1 work inside a Durable Object so its caller can attribute the RPC to one request. */
export const measureD1Usage = async <A>(run: () => Promise<A>): Promise<MeasuredD1Operation<A>> => {
  const usage = noD1Usage()
  try {
    const value = await d1UsageStorage.run(usage, run)
    return { success: true, value, usage }
  } catch (error) {
    // Durable Object RPC transports returned errors, while thrown RPC errors would discard usage.
    return { success: false, error, usage }
  }
}

/** Merge Durable Object D1 metadata into the originating Worker's active request metric. */
export const mergeD1Usage = (usage: Readonly<D1Usage>): void => {
  const state = requestMetricStorage.getStore()
  if (state !== undefined) addD1Usage(state.d1, usage)
}

export const recordCacheOutcome = (outcome: Exclude<CacheOutcome, 'none'>): void => {
  const state = requestMetricStorage.getStore()
  if (state !== undefined) state.cacheOutcome = outcome
}

export const recordTileOfferBatch = (counts: TileOfferCounts): void => {
  const state = requestMetricStorage.getStore()
  if (state === undefined || !isTileOfferRoute(state)) return
  state.tileOfferCounts = counts
  state.tileOfferOutcome =
    counts.accepted > 0
      ? 'accepted'
      : counts.alreadyKnown > 0
        ? 'already-known'
        : counts.rejected > 0
          ? 'rejected'
          : 'accepted'
}

/** Preserve attempted batch size even when offer processing later fails. */
export const recordTileOfferBatchRequested = (requested: number): void => {
  const state = requestMetricStorage.getStore()
  if (state === undefined || !isTileOfferRoute(state)) return
  state.tileOfferCounts = { ...state.tileOfferCounts, requested: finiteCount(requested) }
}

/** Record a hibernating WebSocket tile-offer cache operation without payload dimensions. */
export const recordLiveTileOfferCacheMetric = (
  dataset: MetricDataset | undefined,
  input: MetricClientIdentity & {
    readonly cacheOutcome: Exclude<CacheOutcome, 'none'>
    readonly requested: number
    readonly acknowledged: number
    readonly durationMs: number
  },
): void => {
  const requested = finiteCount(input.requested)
  const acknowledged = Math.min(requested, finiteCount(input.acknowledged))
  writeRequestMetric(
    dataset,
    {
      route: TILE_OFFER_CACHE_ROUTE,
      method: 'WS',
      client: input.client,
      clientVersion: input.clientVersion,
      syncTransport: 'live',
      reconciliationReason: 'post-offer',
      cacheOutcome: input.cacheOutcome,
      tileOfferOutcome: acknowledged > 0 ? 'already-known' : 'requested',
      tileOfferCounts: { requested, accepted: 0, alreadyKnown: acknowledged, rejected: 0 },
      d1: noD1Usage(),
    },
    200,
    input.durationMs,
  )
}

const finalizedTileOfferOutcome = (
  state: RequestMetricState,
  status: number,
): TileOfferBatchOutcome => {
  if (!isTileOfferMetric(state)) return 'none'
  if (!isTileOfferRoute(state)) return state.tileOfferOutcome
  if (status >= 500) return 'failed'
  if (status >= 400) return 'rejected'
  return state.tileOfferOutcome === 'requested' ? 'accepted' : state.tileOfferOutcome
}

const writeRequestMetric = (
  dataset: MetricDataset | undefined,
  state: RequestMetricState,
  status: number,
  durationMs: number,
): void => {
  if (dataset === undefined) return
  const tileOfferOutcome = finalizedTileOfferOutcome(state, status)
  try {
    dataset.writeDataPoint({
      indexes: [state.route],
      // Keep this order in sync with docs/capacity-metrics.md.
      blobs: [
        'v1',
        state.route,
        state.method,
        state.client,
        state.clientVersion,
        state.syncTransport,
        state.reconciliationReason,
        state.cacheOutcome,
        tileOfferOutcome,
        String(status),
      ],
      doubles: [
        1,
        durationMs,
        state.d1.rowsRead,
        state.d1.rowsWritten,
        state.d1.measuredQueries,
        state.d1.unmeasuredQueries,
        state.tileOfferCounts.requested,
        state.tileOfferCounts.accepted,
        state.tileOfferCounts.alreadyKnown,
        state.tileOfferCounts.rejected,
      ],
    })
  } catch (error) {
    // Metrics must never turn a successful application request into a failure.
    console.error('request metrics write failed', error)
  }
}

export const measureRequest = async (
  dataset: MetricDataset | undefined,
  request: Request,
  pathname: string,
  run: () => Promise<Response>,
): Promise<Response> => {
  const applicationPath = unversionedMetricPath(pathname)
  const parsedClient = parseClientMetricsAccept(request.headers.get('accept'))
  const client = normalizeMetricClientIdentity(parsedClient.client, parsedClient.version)
  const method = normalizeMetricMethod(request.method)
  const state: RequestMetricState = {
    route: normalizeMetricRoute(request.method, pathname),
    method,
    client: client.client,
    clientVersion: client.clientVersion,
    syncTransport: parsedClient.transport,
    reconciliationReason: parsedClient.reason,
    cacheOutcome: 'none',
    tileOfferOutcome: applicationPath === TILE_OFFERS_PATH ? 'requested' : 'none',
    tileOfferCounts: { requested: 0, accepted: 0, alreadyKnown: 0, rejected: 0 },
    d1: noD1Usage(),
  }
  const startedAt = performance.now()
  return requestMetricStorage.run(state, async () => {
    try {
      const response = await run()
      writeRequestMetric(dataset, state, response.status, performance.now() - startedAt)
      return response
    } catch (error) {
      writeRequestMetric(dataset, state, 500, performance.now() - startedAt)
      throw error
    }
  })
}

const instrumentedDatabases = new WeakMap<object, D1Database>()

/**
 * Wrap a D1 binding once and attribute result metadata to the current measured request.
 *
 * D1 exposes exact row counts on `run`, `all`, and each batch result. `raw`, `first`, and `exec`
 * discard that metadata, so those calls are counted explicitly as unmeasured rather than silently
 * reported as zero-row queries. `raw` must retain its native positional row semantics: translating
 * object rows back into arrays corrupts joins that contain duplicate column names.
 */
export const instrumentD1 = (database: D1Database): D1Database => {
  const cached = instrumentedDatabases.get(database as object)
  if (cached !== undefined) return cached

  const originals = new WeakMap<object, D1PreparedStatement>()
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrapStatement(statement.bind(...values)),
      first: (...args: [] | [string]) => {
        recordD1Usage({ unmeasuredQueries: 1 })
        return args.length === 0 ? statement.first() : statement.first(args[0])
      },
      run: async <T = Record<string, unknown>>() => {
        recordD1Usage({ measuredQueries: 1 })
        const result = await statement.run<T>()
        recordD1Rows(result)
        return result
      },
      all: async <T = Record<string, unknown>>() => {
        recordD1Usage({ measuredQueries: 1 })
        const result = await statement.all<T>()
        recordD1Rows(result)
        return result
      },
      raw: (options?: { columnNames?: boolean }) => {
        recordD1Usage({ unmeasuredQueries: 1 })
        return options?.columnNames === true
          ? statement.raw({ columnNames: true })
          : statement.raw()
      },
    } as D1PreparedStatement
    originals.set(wrapped as object, statement)
    return wrapped
  }

  const unwrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    originals.get(statement as object) ?? statement

  const wrapSession = (session: D1DatabaseSession): D1DatabaseSession =>
    ({
      prepare: (query: string) => wrapStatement(session.prepare(query)),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        recordD1Usage({ measuredQueries: statements.length })
        const results = await session.batch<T>(statements.map(unwrap))
        for (const result of results) recordD1Rows(result)
        return results
      },
      getBookmark: () => session.getBookmark(),
    }) as D1DatabaseSession

  const wrapped = {
    prepare: (query: string) => wrapStatement(database.prepare(query)),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      recordD1Usage({ measuredQueries: statements.length })
      const results = await database.batch<T>(statements.map(unwrap))
      for (const result of results) recordD1Rows(result)
      return results
    },
    exec: async (query: string) => {
      recordD1Usage({ unmeasuredQueries: 1 })
      return database.exec(query)
    },
    withSession: (constraint?: D1SessionBookmark | D1SessionConstraint) =>
      wrapSession(database.withSession(constraint)),
    dump: () => database.dump(),
  } as D1Database
  instrumentedDatabases.set(database as object, wrapped)
  return wrapped
}
