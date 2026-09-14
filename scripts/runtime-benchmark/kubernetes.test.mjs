import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeResources } from './kubernetes.mjs'

const containers = [
  { key: 'a/backend', name: 'backend' },
  { key: 'b/postgres', name: 'postgres' },
]
const samples = () =>
  [0, 10000, 20000, 30000, 40000].map((at) => ({
    capturedAt: at,
    containers: containers.map((container, index) => ({
      key: container.key,
      startedAt: 0,
      cpuAt: at,
      cpuNanos: at === 0 ? 0 : (90000 + at) * 1e6 * (index + 1),
      memoryAt: at,
      rssBytes: (at === 0 ? 999 : 100 * (index + 1)) * 1024 ** 2,
      workingSetBytes: (at === 0 ? 999 : 120 * (index + 1)) * 1024 ** 2,
    })),
  }))

test('cached warmup and post-window counters do not affect measured CPU or memory', () => {
  const result = summarizeResources(samples(), 5000, 35000, containers)
  assert.equal(result.backend.cpuPercent, 100)
  assert.equal(result.fullStack.cpuPercent, 300)
  assert.equal(result.backend.rssMiB.p50, 100)
  assert.equal(result.fullStack.workingSetMiB.p50, 360)
  assert.deepEqual(result.containers[0].cpuWindow, {
    startAt: 10000,
    endAt: 30000,
    durationMs: 20000,
  })
})

test('a restarted container or reset CPU counter invalidates the comparison', () => {
  const restarted = samples()
  restarted[2].containers[0].startedAt = 15000
  assert.throws(() => summarizeResources(restarted, 5000, 35000, containers), /Container restarted/)
  const reset = samples()
  reset[2].containers[0].cpuNanos = 0
  assert.throws(() => summarizeResources(reset, 5000, 35000, containers), /CPU counter reset/)
})

test('missing counters cannot silently make a runtime look cheaper', () => {
  const missing = samples().map((sample) => ({ ...sample, containers: sample.containers.slice(1) }))
  assert.throws(() => summarizeResources(missing, 5000, 35000, containers), /Missing CPU window/)
})
