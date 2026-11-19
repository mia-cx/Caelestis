import {
  clientMetricsAccept,
  type ReconciliationReason,
  type SyncTransport,
} from '@caelestis/shared'

declare const __CAELESTIS_FRONTEND_VERSION__: string

export const frontendClientAccept = (
  transport: SyncTransport = 'none',
  reason: ReconciliationReason = 'none',
): string =>
  clientMetricsAccept({
    client: 'frontend',
    version: __CAELESTIS_FRONTEND_VERSION__,
    transport,
    reason,
  })
