import {
  clientMetricsAccept,
  type ReconciliationReason,
  type SyncTransport,
} from '@caelestis/shared'
import { compareVersions, parseVersion } from './version.js'

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

/**
 * A server is stale only when both versions parse as x.y.z and the server's is lower than
 * `expected`. Missing or unparseable version fields say nothing about age, so they are never flagged.
 */
export const backendVersionOutdated = (
  serverVersion: string | undefined,
  expected: string,
): boolean => {
  if (serverVersion === undefined) return false
  const advertised = parseVersion(serverVersion)
  const baseline = parseVersion(expected)
  return advertised !== null && baseline !== null && compareVersions(advertised, baseline) < 0
}

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
