// Capture a CPU profile from a Node backend started with --inspect, through the inspector
// protocol, and summarize where self time goes. Diagnostic only: the profiled run is excluded
// from resource comparisons because sampling itself costs CPU.
//
//   node scripts/runtime-benchmark/inspector-profile.mjs ws://127.0.0.1:9229 20 out.cpuprofile
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

const [endpoint, seconds = '20', output = 'backend.cpuprofile'] = process.argv.slice(2)
assert.ok(endpoint, 'Usage: inspector-profile.mjs INSPECTOR_HTTP_OR_WS_URL [SECONDS] [OUTPUT]')

const targetUrl = async () => {
  if (endpoint.startsWith('ws://') || endpoint.startsWith('wss://')) return endpoint
  const list = await (await fetch(`${endpoint.replace(/\/$/, '')}/json/list`)).json()
  const target = list.find((entry) => entry.webSocketDebuggerUrl)
  assert.ok(target, 'No inspector target advertised')
  return target.webSocketDebuggerUrl
}

const socket = new WebSocket(await targetUrl())
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  }
})
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

await call('Profiler.enable')
await call('Profiler.setSamplingInterval', { interval: 1000 })
await call('Profiler.start')
const startedAt = Date.now()
await new Promise((resolve) => setTimeout(resolve, Number(seconds) * 1000))
const { profile } = await call('Profiler.stop')
await call('Profiler.disable')
socket.close()
writeFileSync(output, JSON.stringify(profile))

// Self time per node: samples attributed directly to the node, weighted by the interval deltas.
const byId = new Map(profile.nodes.map((node) => [node.id, node]))
const selfMicros = new Map()
for (let index = 0; index < profile.samples.length; index += 1) {
  const id = profile.samples[index]
  selfMicros.set(id, (selfMicros.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0))
}
const totalMicros = [...selfMicros.values()].reduce((sum, value) => sum + value, 0)
const byFunction = new Map()
for (const [id, micros] of selfMicros) {
  const node = byId.get(id)
  const frame = node.callFrame
  const url = frame.url.replace(/^file:\/\/\/?app\//, '').replace(/^.*node_modules\//, 'nm/')
  const key = `${frame.functionName || '(anonymous)'} ${url}:${frame.lineNumber + 1}`
  byFunction.set(key, (byFunction.get(key) ?? 0) + micros)
}
const top = [...byFunction].sort((left, right) => right[1] - left[1]).slice(0, 30)
console.log(
  `profiled ${((Date.now() - startedAt) / 1000).toFixed(1)} s, ${profile.samples.length} samples, ${(totalMicros / 1e6).toFixed(2)} s sampled; top self time:`,
)
for (const [key, micros] of top) {
  console.log(`${((micros / totalMicros) * 100).toFixed(1).padStart(5)}%  ${key}`)
}
