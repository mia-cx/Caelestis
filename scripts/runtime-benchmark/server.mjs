// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: standalone benchmark, never a cached Turbo task.
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { FilesystemObjectStorage } from '../../packages/storage/dist/filesystem.js'

const backend = pathToFileURL(
  `${process.env.BENCH_BACKEND_DIRECTORY ?? resolve('apps/backend/dist')}/`,
)
const [configModule, liveModule, runtimeModule, serverModule, statusModule] = await Promise.all(
  [
    'node/config.js',
    'node/live.js',
    'node/runtime.js',
    'node/server.js',
    'status-coordinator.js',
  ].map((file) => import(new URL(file, backend))),
)
const { readNodeConfig } = configModule
const { liveRequestContext } = liveModule
const { openNodeRuntime } = runtimeModule
const { listenNodeServer } = serverModule
const { MAX_LIVE_CLIENT_BINARY_BYTES, MAX_LIVE_SUBSCRIBERS } = statusModule

// Benchmark-only bridge: retain the production host's queues, limits and coordinator callbacks.
// This exercises Bun's native network transport without changing production runtime wiring.
class NativeSocket extends EventEmitter {
  constructor(socket) {
    super()
    this.socket = socket
  }
  get readyState() {
    return this.socket.readyState
  }
  get bufferedAmount() {
    return this.socket.getBufferedAmount()
  }
  send(message) {
    this.socket.send(message)
  }
  close(code, reason) {
    this.socket.close(code, reason)
  }
}

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
let close
let port
if (process.env.BENCH_TRANSPORT === 'native') {
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (!url.pathname.startsWith(`${config.basePath}/`))
        return new Response(null, { status: 404 })
      url.pathname = url.pathname.slice(config.basePath.length)
      const context = {}
      const response = await liveRequestContext.run(context, () =>
        runtime.app.fetch(new Request(url, request)),
      )
      if (
        context.accept &&
        response.status === 200 &&
        server.upgrade(request, {
          headers: response.headers,
          data: { accept: context.accept },
        })
      )
        return
      return response
    },
    websocket: {
      idleTimeout: 0,
      maxPayloadLength: MAX_LIVE_CLIENT_BINARY_BYTES,
      backpressureLimit: 8 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      open(socket) {
        socket.data.bridge = new NativeSocket(socket)
        socket.data.accept(socket.data.bridge)
      },
      message(socket, message) {
        socket.data.bridge.emit('message', Buffer.from(message), typeof message !== 'string')
      },
      close(socket, code, reason) {
        socket.data.bridge.emit('close', code, Buffer.from(reason))
      },
    },
  })
  runtime.scheduler.start()
  port = server.port
  close = async () => {
    await runtime.close()
    await server.stop(true)
  }
} else {
  const server = await listenNodeServer(runtime, config)
  port = server.port
  close = () => server.close()
}

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
await close()
