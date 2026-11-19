import { resolve } from 'node:path'
import { pathToFileURL, URL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { closeObjectStorage, nodeObjectStorage } from '@caelestis/storage/node'
import { bun } from './bun.js'
import { readNodeConfig } from './config.js'
import { openNodeRuntime } from './runtime.js'
import { type FrontendHandler, listenNodeServer } from './server.js'

const env = process.env
const config = readNodeConfig(env)
const objects = nodeObjectStorage(env)
let close: (() => Promise<void>) | undefined
let closing = false
let ownershipFailure: Error | undefined
const shutdown = async (error?: Error) => {
  if (closing) return
  closing = true
  if (error) {
    console.error('Runtime ownership lost', error)
    process.exitCode = 1
  }
  const deadline = setTimeout(() => process.exit(1), 30000)
  deadline.unref()
  try {
    await close?.()
  } finally {
    closeObjectStorage(objects)
    clearTimeout(deadline)
  }
}
/**
 * Make `stop` what shutdown closes. Ownership lost while starting could not close it yet, so it
 * closes here and startup fails.
 */
const hold = async (stop: () => Promise<void>) => {
  close = stop
  if (!ownershipFailure) return
  await stop()
  throw ownershipFailure
}
try {
  const runtime = await openNodeRuntime(config, objects, {
    onOwnershipLost: (error) => {
      ownershipFailure = error
      void shutdown(error)
    },
    refreshSocial: (api, readToken) =>
      new Promise<void>((resolveJob, rejectJob) => {
        const worker = new Worker(new URL('./social-worker.js', import.meta.url), {
          workerData: { api, readToken },
        })
        worker.once('error', rejectJob)
        worker.once('exit', (code) =>
          code === 0
            ? resolveJob()
            : rejectJob(new Error(`Social refresh worker exited with ${code}`)),
        )
      }),
  })
  await hold(() => runtime.close())
  if (process.argv.includes('migrate')) {
    await shutdown()
    console.info('Database migrations applied')
  } else {
    const module: { handler: FrontendHandler } | undefined = config.frontendHandler
      ? await import(pathToFileURL(resolve(config.frontendHandler)).href)
      : undefined
    if (bun && module) throw new Error('The Bun backend requires the separate Node frontend image')
    const server = bun
      ? await bun.listenBunServer(runtime, config)
      : await listenNodeServer(runtime, config, module?.handler)
    await hold(() => server.close())
    process.once('SIGTERM', () => {
      void shutdown()
    })
    process.once('SIGINT', () => {
      void shutdown()
    })
    console.info(
      JSON.stringify({
        event: 'listening',
        host: config.host,
        port: server.port,
        database: config.adapter,
        objectStorage: config.objectStorage,
        serverId: runtime.serverId,
      }),
    )
  }
} catch (error) {
  await shutdown()
  throw error
}
