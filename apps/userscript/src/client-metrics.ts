import {
  clientMetricsAccept,
  type ReconciliationReason,
  type SyncTransport,
} from '@caelestis/shared'

export const userscriptVersion =
  typeof __CAELESTIS_USERSCRIPT_VERSION__ === 'string'
    ? __CAELESTIS_USERSCRIPT_VERSION__
    : 'development'

/**
 * The backend version this userscript was built against. Backend and userscript are versioned
 * independently, so this — not the userscript's own version — is the baseline a server's reported
 * version is compared with.
 */
export const expectedBackendVersion =
  typeof __CAELESTIS_EXPECTED_BACKEND_VERSION__ === 'string'
    ? __CAELESTIS_EXPECTED_BACKEND_VERSION__
    : 'development'

export const userscriptClientHeaders = (
  dimensions: { readonly transport?: SyncTransport; readonly reason?: ReconciliationReason } = {},
): Record<string, string> => ({
  accept: clientMetricsAccept({
    client: 'userscript',
    version: userscriptVersion,
    transport: dimensions.transport ?? 'none',
    reason: dimensions.reason ?? 'none',
  }),
})
