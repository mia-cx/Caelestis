import type { ServerInfo } from '@caelestis/shared'
import { Hono } from 'hono'
import type { AuthOptions } from '../auth/middleware.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { createTelemetryLiveRoutes } from './telemetry-live.js'
import { createTelemetryReadRoutes } from './telemetry-reads.js'
import { createTelemetryReportRoutes } from './telemetry-reports.js'

export interface TelemetryRouteOptions {
  readonly currentSeason: number
  /** Names the current season's cached manifest, which tile-history visibility reuses. */
  readonly server?: ServerInfo
}

/** `/telemetry`: live websockets, reads over accepted telemetry, and reporter writes. */
export const createTelemetryRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  options: TelemetryRouteOptions,
) =>
  new Hono()
    .route('/', createTelemetryLiveRoutes(runtime, auth, options))
    .route('/', createTelemetryReadRoutes(runtime, auth, options))
    .route('/', createTelemetryReportRoutes(runtime, auth, options))
