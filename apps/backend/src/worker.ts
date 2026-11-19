import type { Manifest } from '@caelestis/shared'
import type { ReadApi } from '@caelestis/social'
import {
  alarmWatcher,
  cloudflareConfig,
  cloudflareStorage,
  durablePresenceRooms,
} from './adapters/cloudflare/bindings.js'
import { DurableObjectCounterStore } from './adapters/cloudflare/do-counter-store.js'
import { durableLiveSync, durableStatusShards } from './adapters/cloudflare/do-status-read-model.js'
import { IN_PROCESS_READ } from './auth/middleware.js'
import { measureRequest } from './metrics/request-metrics.js'
import { type Backend, composeBackend } from './server/compose.js'
import { type JobName, jobsAt } from './server/jobs.js'
import { publishSocialImages } from './server/social.js'
import { derivedArtifactWriter } from './telemetry/derived-artifact-writer.js'

export { AlarmWatcher } from './alarm-watcher.js'
export { PresenceObject } from './presence-object.js'
export { StatusReadModelObject } from './status-read-model-object.js'
export { TelemetryShard } from './telemetry-shard.js'
export { TemplateBackfillObject } from './template-backfill-object.js'

/** Cloudflare's limit on messages per `sendBatch`. */
const QUEUE_BATCH_LIMIT = 100

const backends = new WeakMap<Env, Backend>()

/** The composed backend for this Worker environment, built on its first request or cron. */
const backendFor = (env: Env): Backend => {
  const held = backends.get(env)
  if (held !== undefined) return held
  const config = cloudflareConfig(env)
  const created = composeBackend(
    {
      ...cloudflareStorage(env),
      serverId: config.serverId,
      counters: new DurableObjectCounterStore(env.TELEMETRY),
      statusShard: durableStatusShards(env.STATUS_READ_MODEL),
      connectLive: durableLiveSync(env.STATUS_READ_MODEL),
      presenceRoom: durablePresenceRooms(env),
      backfill: (name) => env.TEMPLATE_BACKFILL.getByName(name),
      scheduleAlarms: () => alarmWatcher(env).schedule(),
    },
    config,
  )
  backends.set(env, created)
  return created
}

/**
 * The request as the app sees it, without `BASE_PATH`, or null when it is outside the mount.
 * `ROOT_HOST` serves the API without the shared site's prefix.
 */
const requestAtBasePath = (
  request: Request,
  basePath: string | undefined,
  rootHost: string | undefined,
): Request | null => {
  if (basePath === undefined) return request
  const url = new URL(request.url)
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
    return url.hostname === rootHost ? request : null
  }
  url.pathname = url.pathname.slice(basePath.length) || '/'
  return new Request(url.href, request)
}

/** Read this deployment's own API in-process: no network hop and no stored token. */
const readSelf =
  (env: Env): ReadApi =>
  async (path) => {
    const response = await backendFor(env).app.fetch(
      new Request(new URL(path, 'https://self.invalid/v1/').href),
      { [IN_PROCESS_READ]: true },
    )
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response
  }

/** Queue one share-GIF render per published template; the queue consumer renders each. */
const enqueueSocialRefresh = async (env: Env): Promise<void> => {
  const queue = env.SOCIAL_REFRESH
  if (queue === undefined) return
  const manifest = (await (await readSelf(env)('manifest')).json()) as Manifest
  const messages = manifest.templates
    .filter((template) => template.published)
    .map((template) => ({ body: { templateId: template.id } }))
  for (let start = 0; start < messages.length; start += QUEUE_BATCH_LIMIT)
    await queue.sendBatch(messages.slice(start, start + QUEUE_BATCH_LIMIT))
}

export default {
  // Workers always pass the execution context; unit tests call fetch without one.
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const mountedRequest = requestAtBasePath(request, cloudflareConfig(env).basePath, env.ROOT_HOST)
    if (mountedRequest === null) {
      return measureRequest(
        env.REQUEST_METRICS,
        request,
        'other',
        async () => new Response('Not Found', { status: 404 }),
      )
    }

    try {
      return await measureRequest(
        env.REQUEST_METRICS,
        mountedRequest,
        new URL(mountedRequest.url).pathname,
        async () => backendFor(env).app.fetch(mountedRequest),
      )
    } finally {
      // Derived mismatch artifacts queued by this request finish after the reply; the Worker
      // must keep the isolate alive for them, or they only become later cache misses.
      ctx?.waitUntil(derivedArtifactWriter.drain())
    }
  },

  async scheduled(controller, env, ctx): Promise<void> {
    const jobs: Record<JobName, () => Promise<void>> = {
      ...backendFor(env).jobs,
      social: () => enqueueSocialRefresh(env),
    }
    for (const name of jobsAt(controller.cron)) ctx.waitUntil(jobs[name]())
  },

  // One template per batch (max_batch_size = 1). A throw retries it, and its previous GIF stays.
  async queue(batch, env): Promise<void> {
    const { objects } = cloudflareStorage(env)
    for (const message of batch.messages)
      await publishSocialImages(readSelf(env), objects, message.body.templateId)
  },
} satisfies ExportedHandler<Env, { templateId: string }>
