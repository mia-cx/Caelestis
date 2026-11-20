import { API_VERSION_PATH, resolveServerUrl } from '@caelestis/shared'

/** `legacy` servers predate the `/v1` prefix; the backend still mounts both. */
export type ServerApiVersion = 'v1' | 'legacy'

/** Resolve one backend route without changing the configured server's identity. */
export const endpointUrl = (
  serverUrl: string,
  route: string,
  version: ServerApiVersion = 'v1',
): string => {
  const path = route.startsWith('/') ? route : `/${route}`
  return `${resolveServerUrl(serverUrl)}${version === 'v1' ? API_VERSION_PATH : ''}${path}`
}
