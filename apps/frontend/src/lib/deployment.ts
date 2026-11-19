/**
 * Where this dashboard lives and how its pieces address each other. Erasable TypeScript only: the
 * Node server, Vite config and dev script import it directly.
 */

export const DASHBOARD_ORIGIN = 'https://caelest.is'
/** The official dashboard's previous host, which hands browser state over (dashboard-move.ts). */
export const FORMER_DASHBOARD_ORIGIN = 'https://caelestis.mia.cx'
/** The public hostname the dev tunnel forwards to Vite. */
export const DEV_TUNNEL_HOST = 'caelestis-dev-frontend.mia.cx'

/** The credentialed read proxy: browser reads that hold no token go through the deployment. */
export const READ_PROXY = '/api'
export const LIVE_PATH = '/telemetry/live'

/**
 * Every browser storage key. All share the `caelestis:` prefix, which is how a dashboard move
 * finds the entries to carry over.
 */
export const STORAGE_PREFIX = 'caelestis:'
export const STORAGE_KEYS = {
  server: 'caelestis:server',
  token: 'caelestis:token',
  liveClientId: 'caelestis:live-client-id',
  theme: 'caelestis:theme',
  timelapseSpeed: 'caelestis:timelapse-speed',
  overlayAlpha: 'caelestis:overlay-alpha',
  colourSort: 'caelestis:colour-sort',
  paceWindows: 'caelestis:pace-windows',
  paceAllUsers: 'caelestis:pace-all-users',
  estimatePeriod: 'caelestis:estimate-period',
} as const
