import { Hono } from 'hono'
import type { AuthOptions } from '../auth/middleware.js'
import type { BackendRuntime } from '../runtime/backend-runtime.js'
import { createTelemetryLiveRoutes } from './telemetry-live.js'
import { createTelemetryReadRoutes, type TelemetryRouteOptions } from './telemetry-reads.js'
import { createTelemetryReportRoutes } from './telemetry-reports.js'

export const createTelemetryRoutes = (
  runtime: BackendRuntime,
  auth: AuthOptions,
  options: TelemetryRouteOptions,
) =>
  new Hono()
    .route('/', createTelemetryLiveRoutes(runtime, auth, options.currentSeason))
    .route('/', createTelemetryReadRoutes(runtime, auth, options))
    .route('/', createTelemetryReportRoutes(runtime, auth, options.currentSeason))
