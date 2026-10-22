import { env } from 'cloudflare:workers'
import { R2ObjectStorage } from '@caelestis/storage/r2'
import type { Handle } from '@sveltejs/kit/hooks'
import { dev } from '$app/env'

/** Resolve host config once, so routes read `locals` alone on either host. */
export const handle: Handle = ({ event, resolve }) => {
  // The custom Node server attaches its config to the request. Workers expose bindings as `env`.
  const node = event.platform?.req.caelestis
  event.locals.backendEnvironment = node?.env ?? env
  event.locals.objectStorage =
    node?.objectStorage ??
    (env.SOCIAL_IMAGES === undefined ? undefined : new R2ObjectStorage(env.SOCIAL_IMAGES))
  // Preserve the public HTTPS origin when cloudflared forwards to Vite over HTTP.
  if (dev && event.url.hostname === 'caelestis-dev-frontend.mia.cx') {
    event.url.protocol = 'https:'
  }
  return resolve(event)
}
