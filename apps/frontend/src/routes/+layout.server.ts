import type {
  AlarmsResponse,
  CanvasTilesResponse,
  Manifest,
  ServerInfo,
  StatusResponse,
} from '@caelestis/shared'
import { readBackendJson } from '#lib/server/backend.js'
import { socialMetadata } from '#lib/server/social.js'
import { ensureSocialImage } from '#lib/server/social-images.js'
import { sanitizeServerInfo } from '#lib/server-info.js'
import type { AppBootstrap } from '#lib/state/app.svelte.js'
import type { LayoutServerLoad } from './$types'

const emptyBootstrap = (error: unknown): AppBootstrap => ({
  server: null,
  manifest: null,
  statuses: [],
  statusRevision: null,
  alarms: [],
  alarmsVersion: null,
  canvas: [],
  needsRecovery: true,
  error: error instanceof Error ? error.message : String(error),
})

/**
 * Bootstrap the app once per document. The client keeps live state after hydration and discards
 * this data, so client navigations must not rerun it: the URL is read untracked, and link previews
 * describe the page a crawler requested.
 */
export const load: LayoutServerLoad = async (event) => {
  // A copy: reading any part of `event.url` itself would track it again.
  const url = event.untrack(() => new URL(event.url))
  const backend = { fetch: event.fetch, locals: event.locals, url }
  const withSocial = async (bootstrap: AppBootstrap) => {
    const manifest = bootstrap.manifest
    // A missing preview must not prevent the dashboard from loading.
    let social: Awaited<ReturnType<typeof socialMetadata>>
    try {
      social = await socialMetadata(
        url,
        bootstrap,
        event.locals.objectStorage,
        manifest ? (template) => ensureSocialImage(backend, manifest.season, template) : undefined,
      )
    } catch (error) {
      console.error('social image lookup failed', error)
      social = await socialMetadata(url, bootstrap)
    }
    return { bootstrap, social }
  }
  try {
    const [serverInfo, manifest] = await Promise.all([
      readBackendJson<ServerInfo>(backend, '/v1/server'),
      readBackendJson<Manifest>(backend, '/v1/manifest'),
    ])
    const server = sanitizeServerInfo(serverInfo)
    const [status, alarms, canvas] = await Promise.allSettled([
      readBackendJson<StatusResponse>(backend, `/v1/telemetry/status?season=${manifest.season}`),
      readBackendJson<AlarmsResponse>(backend, `/v1/telemetry/alarms?season=${manifest.season}`),
      readBackendJson<CanvasTilesResponse>(
        backend,
        `/v1/telemetry/canvas?season=${manifest.season}`,
      ),
    ])
    const bootstrap: AppBootstrap = {
      server,
      manifest,
      statuses: status.status === 'fulfilled' ? status.value.templates : [],
      statusRevision: status.status === 'fulfilled' ? (status.value.revision ?? null) : null,
      alarms: alarms.status === 'fulfilled' ? alarms.value.alarms : [],
      alarmsVersion: alarms.status === 'fulfilled' ? (alarms.value.version ?? null) : null,
      canvas: canvas.status === 'fulfilled' ? canvas.value.tiles : [],
      needsRecovery: [status, alarms, canvas].some((result) => result.status === 'rejected'),
      error: null,
    }
    return withSocial(bootstrap)
  } catch (error) {
    return withSocial(emptyBootstrap(error))
  }
}
