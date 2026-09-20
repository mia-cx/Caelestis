// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: standalone benchmark, never a cached Turbo task.
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { FilesystemObjectStorage } from '../../packages/storage/dist/filesystem.js'

const backend = pathToFileURL(
  `${process.env.BENCH_BACKEND_DIRECTORY ?? resolve('apps/backend/dist')}/`,
)
const [configModule, runtimeModule, serverModule, statusModule] = await Promise.all(
  ['node/config.js', 'node/runtime.js', 'node/server.js', 'status-coordinator.js'].map(
    (file) => import(new URL(file, backend)),
  ),
)
const { readNodeConfig } = configModule
const { openNodeRuntime } = runtimeModule
const { listenNodeServer } = serverModule
const { MAX_LIVE_SUBSCRIBERS } = statusModule

const config = readNodeConfig()
const runtime = await openNodeRuntime(
  config,
  new FilesystemObjectStorage(process.env.OBJECT_DIRECTORY),
  {
    onOwnershipLost(error) {
      console.error(error)
      process.exit(1)
    },
  },
)
// Exercise the same HTTP and socket adapter selected by each production image.
const server =
  process.env.BENCH_TRANSPORT === 'native'
    ? await (await import(new URL('bun/server.js', backend))).listenBunServer(runtime, config)
    : await listenNodeServer(runtime, config)
const { port } = server

let baseline
let delaySamples = []
let previous = performance.now()
const timer = setInterval(() => {
  const now = performance.now()
  if (baseline) delaySamples.push(Math.max(0, now - previous - 20))
  previous = now
}, 20)
const reply = (data) => console.log(JSON.stringify({ benchmark: true, ...data }))
reply({ type: 'ready', port, runtime: process.versions, liveSubscriberLimit: MAX_LIVE_SUBSCRIBERS })
for await (const line of createInterface({ input: process.stdin })) {
  if (line === 'begin') {
    delaySamples = []
    baseline = { cpu: process.cpuUsage(), at: performance.now() }
    reply({ type: 'begin' })
  }
  if (line === 'end') {
    reply({
      type: 'end',
      cpu: process.cpuUsage(baseline.cpu),
      elapsedMs: performance.now() - baseline.at,
      delaySamples,
    })
    baseline = undefined
  }
  if (line === 'stop') break
}
clearInterval(timer)
await server.close()
