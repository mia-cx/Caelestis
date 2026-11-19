import { env } from 'cloudflare:workers'
import { R2ObjectStorage } from '@caelestis/storage/r2'
import type { Handle } from '@sveltejs/kit/hooks'
import {
  DASHBOARD_ORIGIN,
  DEV_TUNNEL_HOST,
  FORMER_DASHBOARD_ORIGIN,
  STORAGE_KEYS,
} from '#lib/deployment.js'
import { leaveFormerHost, MOVE_PATH, receiveMove } from '#lib/server/dashboard-move.js'
import { dev } from '$app/env'

/** The Caelestis docs site. Every dashboard forwards its `/docs` paths there. */
const DOCS_ORIGIN = 'https://docs.caelest.is'

/** Resolve host config once, so routes read `locals` alone on either host. */
export const handle: Handle = ({ event, resolve }) => {
  const { origin, pathname, search } = event.url
  if (origin === FORMER_DASHBOARD_ORIGIN) return leaveFormerHost(event.request, event.url)
  if (origin === DASHBOARD_ORIGIN && pathname === MOVE_PATH && event.request.method === 'POST') {
    return receiveMove(event.request)
  }
  if (pathname === '/docs' || pathname.startsWith('/docs/')) {
    const path = pathname.slice('/docs'.length) || '/'
    return Response.redirect(`${DOCS_ORIGIN}${path}${search}`, 308)
  }

  // The custom Node server attaches its config to the request. Workers expose bindings as `env`.
  const node = event.platform?.req.caelestis
  event.locals.backendEnvironment = node?.env ?? env
  event.locals.objectStorage =
    node?.objectStorage ??
    (env.SOCIAL_IMAGES === undefined ? undefined : new R2ObjectStorage(env.SOCIAL_IMAGES))
  // Preserve the public HTTPS origin when cloudflared forwards to Vite over HTTP.
  if (dev && event.url.hostname === DEV_TUNNEL_HOST) {
    event.url.protocol = 'https:'
  }
  return resolve(event, {
    transformPageChunk: ({ html }) => html.replace('%caelestis.theme-key%', STORAGE_KEYS.theme),
  })
}
