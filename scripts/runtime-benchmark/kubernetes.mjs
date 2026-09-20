import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import {
  CLIENT_COMMAND_TIMEOUT_MS,
  description,
  distribution,
  fixtures,
  schedule,
  traffic,
} from './traffic.mjs'

const execute = promisify(execFile)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const mib = 1024 ** 2
const OBSERVATION_TIMEOUT_MS = 30000

/** Use only kubelet counter samples inside the measured phase, excluding cached warmup data. */
export function summarizeResources(samples, startAt, endAt, containers) {
  for (const sample of samples)
    for (const point of sample.containers)
      assert.ok(
        [point.cpuAt, point.cpuNanos, point.memoryAt, point.rssBytes, point.workingSetBytes].every(
          Number.isFinite,
        ),
        `Incomplete kubelet sample: ${point.key}`,
      )
  const metrics = containers.map((container) => {
    const points = samples.flatMap((sample) =>
      sample.containers.filter(
        (point) => point.key === container.key && point.cpuAt >= startAt && point.cpuAt <= endAt,
      ),
    )
    const first = points[0]
    const last = points.at(-1)
    assert.ok(first && last && last.cpuAt > first.cpuAt, `Missing CPU window: ${container.key}`)
    assert.ok(last.cpuAt - first.cpuAt >= (endAt - startAt) / 2, 'Insufficient CPU coverage')
    for (const [index, point] of points.entries()) {
      assert.equal(point.startedAt, first.startedAt, `Container restarted: ${container.key}`)
      if (index) assert.ok(point.cpuNanos >= points[index - 1].cpuNanos, 'CPU counter reset')
    }
    return {
      ...container,
      cpuPercent: ((last.cpuNanos - first.cpuNanos) / ((last.cpuAt - first.cpuAt) * 1e6)) * 100,
      cpuWindow: { startAt: first.cpuAt, endAt: last.cpuAt, durationMs: last.cpuAt - first.cpuAt },
    }
  })
  const scope = (selected) => {
    const memory = samples.flatMap((sample) => {
      const points = sample.containers.filter((point) => selected.some((c) => c.key === point.key))
      if (
        points.length !== selected.length ||
        points.some((point) => point.memoryAt < startAt || point.memoryAt > endAt)
      )
        return []
      return [
        {
          rss: points.reduce((sum, point) => sum + point.rssBytes, 0) / mib,
          workingSet: points.reduce((sum, point) => sum + point.workingSetBytes, 0) / mib,
        },
      ]
    })
    assert.ok(memory.length > 0, 'Missing memory samples')
    return {
      cpuPercent: selected.reduce((sum, c) => sum + c.cpuPercent, 0),
      rssMiB: distribution(memory.map((point) => point.rss)),
      workingSetMiB: distribution(memory.map((point) => point.workingSet)),
    }
  }
  return {
    startAt,
    endAt,
    durationMs: endAt - startAt,
    containers: metrics,
    backend: scope(metrics.filter((container) => container.name === 'backend')),
    fullStack: scope(metrics),
  }
}

/** Replay the 256-user trace against an isolated production CNPG/S3 stack after recovery checks. */
export async function benchmarkKubernetes({
  context,
  namespace,
  site,
  adminToken,
  output,
  observe = false,
  env = process.env,
  transport = 'Production images through Traefik HTTPS/WSS and the Node frontend',
}) {
  const kubectl = async (...args) => {
    const { stdout } = await execute('kubectl', ['--context', context, ...args], {
      encoding: 'utf8',
      env,
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout.trim()
  }
  const inspect = async () => {
    const pods = JSON.parse(await kubectl('-n', namespace, 'get', 'pods', '-o', 'json')).items
    return pods
      .filter((pod) => pod.status.phase === 'Running')
      .flatMap((pod) =>
        pod.status.containerStatuses.map((container) => ({
          key: `${pod.metadata.uid}/${container.name}`,
          pod: pod.metadata.name,
          uid: pod.metadata.uid,
          node: pod.spec.nodeName,
          name: container.name,
          image: container.image,
          imageID: container.imageID,
          resources: pod.spec.containers.find((item) => item.name === container.name).resources,
          restartCount: container.restartCount,
        })),
      )
      .sort((a, b) => a.key.localeCompare(b.key))
  }
  const containers = await inspect()
  assert.equal(containers.length, 5, 'Expected backend, frontend, two CNPG instances, and S3')
  assert.equal(containers.filter((c) => c.name === 'backend').length, 1)
  const nodes = [...new Set(containers.map((container) => container.node))]
  const snapshot = async () => ({
    capturedAt: Date.now(),
    driverRssBytes: process.memoryUsage().rss,
    containers: (
      await Promise.all(
        nodes.map(async (node) => {
          const summary = JSON.parse(
            await kubectl('get', '--raw', `/api/v1/nodes/${node}/proxy/stats/summary`),
          )
          return summary.pods
            .filter((pod) => pod.podRef.namespace === namespace)
            .flatMap((pod) =>
              pod.containers.flatMap((container) => {
                const key = `${pod.podRef.uid}/${container.name}`
                if (!containers.some((item) => item.key === key)) return []
                return [
                  {
                    key,
                    startedAt: container.startTime,
                    cpuAt: Date.parse(container.cpu.time),
                    cpuNanos: container.cpu.usageCoreNanoSeconds,
                    memoryAt: Date.parse(container.memory.time),
                    rssBytes: container.memory.rssBytes,
                    workingSetBytes: container.memory.workingSetBytes,
                  },
                ]
              }),
            )
        }),
      )
    ).flat(),
  })
  const warmupMs = 35000
  const measuredMs = Number(process.env.CAELESTIS_TEST_BENCHMARK_MEASURE_MS ?? 60000)
  assert.ok(Number.isInteger(measuredMs) && measuredMs >= 60000, 'Measure for at least 60 seconds')
  const durationMs = warmupMs + measuredMs
  // The corrected trace is 256 users; a capacity ladder raises it with the backend's live
  // subscriber limit raised to match (CAELESTIS_LIVE_SUBSCRIBER_LIMIT through the backend env).
  const users = Number(process.env.CAELESTIS_TEST_BENCHMARK_USERS ?? 256)
  assert.ok(Number.isInteger(users) && users >= 2, 'CAELESTIS_TEST_BENCHMARK_USERS must be >= 2')
  const scenario = process.env.BENCH_SCENARIO ?? 'stable'
  assert.ok(['stable', 'raid'].includes(scenario), 'BENCH_SCENARIO must be stable or raid')
  const fixture = await fixtures(durationMs, users, { raid: scenario === 'raid' })
  const trace = schedule(durationMs, fixture)
  const report = {
    scenario,
    issue: 390,
    context,
    namespace,
    site,
    startedAt: new Date().toISOString(),
    description: {
      ...description,
      users,
      explorers: fixture.explorers,
      painters: fixture.painters,
    },
    warmupMs,
    measuredMs,
    observe,
    commandTimeoutMs: observe ? OBSERVATION_TIMEOUT_MS : CLIENT_COMMAND_TIMEOUT_MS,
    transport,
    database: 'Two CNPG PostgreSQL instances with verified TLS; S3 objects in MinIO',
    resources:
      'Kubelet cumulative CPU and cgroup RSS/working set for the five application containers; shared Traefik, operators, storage engines, node services, and driver excluded',
    metricWindow:
      'Kubelet caches snapshots. Only timestamps inside the measured phase contribute; each CPU interval is recorded and can be shorter than the traffic window.',
    containers,
    nodes: await Promise.all(
      nodes.map(async (name) => {
        const node = JSON.parse(await kubectl('get', 'node', name, '-o', 'json'))
        const { architecture, kernelVersion, osImage, kubeletVersion, containerRuntimeVersion } =
          node.status.nodeInfo
        return {
          name,
          capacity: node.status.capacity,
          architecture,
          kernelVersion,
          osImage,
          kubeletVersion,
          containerRuntimeVersion,
        }
      }),
    ),
    runtime: JSON.parse(
      await kubectl(
        '-n',
        namespace,
        'exec',
        'deployment/test-caelestis',
        '-c',
        'backend',
        '--',
        'node',
        '-p',
        'JSON.stringify(process.versions)',
      ),
    ),
    driver: process.versions,
    sourceHashes: Object.fromEntries(
      await Promise.all(
        ['kubernetes.mjs', 'traffic.mjs', 'raid-claims.mjs'].map(async (file) => [
          file,
          hash(await readFile(new URL(file, import.meta.url))),
        ]),
      ),
    ),
    traceSha256: hash(JSON.stringify(trace)),
    fixture: {
      templateSha256: hash(fixture.template),
      framesSha256: hash(
        JSON.stringify(
          fixture.frames.map((frame) => frame.map(({ tile, sha256 }) => ({ tile, sha256 }))),
        ),
      ),
    },
  }
  await writeFile(`${output}/benchmark-trace.json`, JSON.stringify(trace))
  let timer, pending, startAt, samples, sampleError, driverCpu
  let phase = 0
  const sample = () => {
    if (pending) return pending
    pending = snapshot()
      .then((point) => samples.push(point))
      .catch((error) => {
        sampleError = error
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
  const begin = async () => {
    phase++
    startAt = Date.now()
    driverCpu = process.cpuUsage()
    samples = []
    sampleError = undefined
    await sample()
    timer = setInterval(() => void sample(), 1000)
  }
  const end = async () => {
    clearInterval(timer)
    const endAt = Date.now()
    const cpu = process.cpuUsage(driverCpu)
    await pending
    await sample()
    await writeFile(`${output}/benchmark-resource-samples-${phase}.json`, JSON.stringify(samples))
    if (sampleError) throw sampleError
    let result
    try {
      result = summarizeResources(samples, startAt, endAt, containers)
    } catch (error) {
      // An early workload failure can precede two fresh kubelet snapshots.
      // Preserve that workload error and the raw diagnostics; never invent zero CPU.
      if (phase !== 1) throw error
      return { phase: 'warmup', unavailable: String(error), startAt, endAt }
    }
    result.phase = phase === 1 ? 'warmup' : 'measured'
    result.driver = {
      cpuPercent: ((cpu.user + cpu.system) / ((endAt - startAt) * 1000)) * 100,
      rssMiB: distribution(
        samples
          .filter((sample) => sample.capturedAt <= endAt)
          .map((sample) => sample.driverRssBytes / mib),
      ),
      scope: 'Load-generator process; kubectl subprocesses excluded',
    }
    return result
  }
  // Failed runs retain a diagnostic snapshot; successful traffic resets at its measured boundary.
  const backendStages = async (query = '') => {
    try {
      const response = await fetch(`${site}/backend/v1/admin/server/ingest-timings${query}`, {
        headers: { authorization: `Bearer ${adminToken}` },
        signal: AbortSignal.timeout(30000),
      })
      return response.ok ? await response.json() : { unavailable: `HTTP ${response.status}` }
    } catch (error) {
      return { unavailable: String(error) }
    }
  }
  try {
    console.log(
      `Replaying ${users} users: 35-second warmup, then ${measuredMs / 1000} measured seconds`,
    )
    report.result = await traffic({
      site,
      adminToken,
      trace,
      fixture,
      warmupMs,
      durationMs,
      begin,
      end,
      commandTimeoutMs: report.commandTimeoutMs,
    })
    assert.deepEqual(await inspect(), containers, 'Containers changed during the measured workload')
    report.completed = true
    report.passed = Object.values(report.result.correctness.clientDeadlineMisses).every(
      (count) => count === 0,
    )
  } catch (error) {
    report.passed = false
    report.error = String(error)
    report.result = error.benchmarkResult
    if (report.result) report.result.backendStages = await backendStages()
    throw error
  } finally {
    clearInterval(timer)
    await pending
    await writeFile(`${output}/benchmark.json`, JSON.stringify(report, null, 2))
  }
  console.log(
    `${users}-user benchmark ${report.passed ? 'passed' : 'completed with client deadline misses'}; results: ${output}/benchmark.json`,
  )
  return {
    completed: report.completed,
    passed: report.passed,
    clientDeadlineMisses: report.result.correctness.clientDeadlineMisses,
  }
}
