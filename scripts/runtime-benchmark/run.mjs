// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: standalone benchmark, never a cached Turbo task.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { description, distribution, fixtures, schedule, traffic } from './traffic.mjs'

// node scripts/runtime-benchmark/run.mjs [output directory]
// NODE_BINARY, BUN_BINARY, BENCH_REPEATS, BENCH_WARMUP_MS, BENCH_MEASURE_MS,
// BENCH_VARIANTS, BENCH_SERVER_CPUS and BENCH_DATABASE_CPUS override the recorded defaults.
const output = resolve(process.argv[2] ?? `test-results/runtime-benchmark/${Date.now()}`)
await mkdir(output, { recursive: true })
const node = process.env.NODE_BINARY ?? process.execPath
const bun = process.env.BUN_BINARY ?? 'bun'
const repeats = Number(process.env.BENCH_REPEATS ?? 3)
const warmupMs = Number(process.env.BENCH_WARMUP_MS ?? 35000)
const measuredMs = Number(process.env.BENCH_MEASURE_MS ?? 60000)
const durationMs = warmupMs + measuredMs
const users = Number(process.env.BENCH_USERS ?? 10)
assert.ok(
  [10, 100, 256, 288, 320, 384, 1000].includes(users),
  'BENCH_USERS must be 10, 100, 256, 288, 320, 384, or 1000',
)
const variants = (process.env.BENCH_VARIANTS ?? 'node,bun-compat,bun-native').split(',')
const miniflareOnly = variants.length === 1 && variants[0] === 'miniflare'
const requestedBuild = resolve(process.env.BENCH_BUILD ?? 'apps/backend/dist')
assert.ok(
  !miniflareOnly || process.env.BENCH_BUILD === undefined,
  'Miniflare builds its Worker from source',
)
assert.ok(
  miniflareOnly || !variants.includes('miniflare'),
  'Run Miniflare separately: its storage and process metrics differ',
)
const serverCpus = process.env.BENCH_SERVER_CPUS ?? '2,3'
const databaseCpus = process.env.BENCH_DATABASE_CPUS ?? '4,5'
const container = `caelestis-runtime-benchmark-${randomUUID().slice(0, 8)}`
const directory = await mkdtemp(join(tmpdir(), 'caelestis-runtime-benchmark-'))
const scenario = process.env.BENCH_SCENARIO ?? 'stable'
assert.ok(['stable', 'raid'].includes(scenario), 'BENCH_SCENARIO must be stable or raid')
const fixture = await fixtures(durationMs, users, { raid: scenario === 'raid' })
const trace = schedule(durationMs, fixture)
const traceJson = JSON.stringify(trace)
await writeFile(join(output, 'trace.json'), traceJson)
const sourceHashes = Object.fromEntries(
  await Promise.all(
    [
      'run.mjs',
      'server.mjs',
      'traffic.mjs',
      'raid-claims.mjs',
      ...(miniflareOnly ? ['miniflare-server.mjs'] : []),
    ].map(async (name) => [
      name,
      createHash('sha256')
        .update(await readFile(new URL(name, import.meta.url)))
        .digest('hex'),
    ]),
  ),
)
const report = {
  sourceHashes,
  scenario,
  fault: process.env.BENCH_DROP_CLAIMS === '1' ? 'drop client 0 region updates' : null,
  issue: 385,
  pr: 351,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(),
  description: { ...description, users, explorers: fixture.explorers, painters: fixture.painters },
  warmupMs,
  measuredMs,
  repeats,
  diagnosticCpuProfile: process.env.BENCH_CPU_PROFILE === '1',
  transport:
    'production NodeLiveHost and shared coordinators; bun-native selects the production Bun HTTP/WebSocket adapter',
  database: 'isolated local PostgreSQL 18, fresh database per run, TLS disabled',
  objects: 'local filesystem; no S3, Traefik, frontend rendering or Wplace HTTP traffic',
  ...(miniflareOnly
    ? {
        transport: 'production Worker and Durable Object adapters in Miniflare/workerd',
        database: 'ephemeral local D1 and SQLite-backed Durable Object emulation inside workerd',
        objects: 'ephemeral local R2 emulation; no remote Cloudflare services',
        metricScope:
          'aggregate workerd and Miniflare controller CPU/RSS; local storage emulation included; no isolate event-loop measurement',
      }
    : {}),
  host: {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    serverCpus,
    databaseCpus,
    driverAffinity: execFileSync('taskset', ['-pc', String(process.pid)], {
      encoding: 'utf8',
    }).trim(),
  },
  versions: {
    node: execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(),
    bun: execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim(),
  },
  traceSha256: createHash('sha256').update(traceJson).digest('hex'),
  fixtures: {
    templateSha256: createHash('sha256').update(fixture.template).digest('hex'),
    width: fixture.width,
    height: fixture.height,
    origin: fixture.origin,
    frames: fixture.frames.map((tiles) =>
      tiles.map(({ tile, bytes, sha256 }) => ({ tile, bytes: bytes.length, sha256 })),
    ),
  },
  runs: [],
}
const save = () => writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2))
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  }).trim()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let active
let databaseCreated = false
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.stdin.end('stop\n')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000)
  try {
    await exited
  } finally {
    clearTimeout(timeout)
  }
}
process.once('SIGTERM', () => {
  void stopChild(active).finally(async () => {
    if (databaseCreated) docker('rm', '-fv', container)
    await rm(directory, { recursive: true, force: true })
    process.exit(143)
  })
})
process.once('SIGINT', () => {
  void stopChild(active).finally(async () => {
    if (databaseCreated) docker('rm', '-fv', container)
    await rm(directory, { recursive: true, force: true })
    process.exit(130)
  })
})
try {
  let backendDirectory = requestedBuild
  const buildHash = createHash('sha256')
  for (const file of (await readdir(backendDirectory, { recursive: true }))
    .filter((file) => file.endsWith('.js'))
    .sort()) {
    buildHash.update(file)
    buildHash.update(await readFile(join(backendDirectory, file)))
  }
  report.backendSha256 = buildHash.digest('hex')
  const statusSource = await readFile(join(backendDirectory, 'status-coordinator.js'), 'utf8')
  const currentLimit = Number(statusSource.match(/export const MAX_LIVE_SUBSCRIBERS = (\d+);/)[1])
  report.capacity = {
    productionLimit: currentLimit,
    benchmarkLimit: Math.max(currentLimit, users),
    productionAdmitsRequestedUsers: users <= currentLimit,
  }
  if (users > currentLimit) {
    assert.ok(!miniflareOnly, 'Miniflare comparison uses the unchanged production subscriber limit')
    // Only the disposable compiled copy changes. Production source and build stay untouched.
    const snapshot = join(directory, 'backend')
    backendDirectory = join(snapshot, 'dist')
    await cp(requestedBuild, backendDirectory, { recursive: true })
    for (const name of [
      'node_modules',
      'package.json',
      'migrations',
      'migrations-postgres',
      'migrations-mariadb',
    ])
      await symlink(resolve('apps/backend', name), join(snapshot, name))
    const modified = statusSource.replace(
      `export const MAX_LIVE_SUBSCRIBERS = ${currentLimit};`,
      `export const MAX_LIVE_SUBSCRIBERS = ${users};`,
    )
    await writeFile(join(backendDirectory, 'status-coordinator.js'), modified)
    report.capacity.compiledStatusSha256 = createHash('sha256').update(modified).digest('hex')
  }
  if (!miniflareOnly)
    docker(
      'run',
      '-d',
      '--name',
      container,
      '--cpuset-cpus',
      databaseCpus,
      '-p',
      '127.0.0.1::5432',
      '-e',
      'POSTGRES_PASSWORD=benchmark-local-only',
      'postgres:18',
    )
  databaseCreated = !miniflareOnly
  const inspect = miniflareOnly ? null : JSON.parse(docker('inspect', container))[0]
  const pgPort = inspect?.NetworkSettings.Ports['5432/tcp'][0].HostPort
  const group = miniflareOnly
    ? null
    : (await readFile(`/proc/${inspect.State.Pid}/cgroup`, 'utf8'))
        .trim()
        .split('\n')
        .find((line) => line.startsWith('0::'))
        .slice(3)
  const dbCpu = async () =>
    miniflareOnly
      ? 0
      : Number(
          (await readFile(`/sys/fs/cgroup${group}/cpu.stat`, 'utf8')).match(/usage_usec (\d+)/)[1],
        )
  report.databaseImage = inspect?.Image ?? null
  for (let attempt = 0; !miniflareOnly; attempt++) {
    try {
      docker('exec', container, 'pg_isready', '-U', 'postgres')
      break
    } catch (error) {
      if (attempt === 30) throw error
      await sleep(500)
    }
  }
  for (let repeat = 0; repeat < repeats; repeat++) {
    const order = [
      ...variants.slice(repeat % variants.length),
      ...variants.slice(0, repeat % variants.length),
    ]
    for (const variant of order) {
      assert.ok(['node', 'bun-compat', 'bun-native', 'miniflare'].includes(variant))
      const label = `${repeat + 1}-${variant}`
      const database = `run_${repeat}_${variant.replaceAll('-', '_')}`
      if (!miniflareOnly) docker('exec', container, 'createdb', '-U', 'postgres', database)
      const runDirectory = join(directory, label)
      await mkdir(runDirectory)
      const log = createWriteStream(join(output, `${label}.log`))
      const waiters = new Map(),
        messages = new Map()
      const child = spawn(
        'taskset',
        [
          '-c',
          serverCpus,
          variant === 'node' || miniflareOnly ? node : bun,
          ...(variant === 'node' && process.env.BENCH_CPU_PROFILE === '1'
            ? ['--cpu-prof', `--cpu-prof-dir=${output}`]
            : []),
          miniflareOnly
            ? 'scripts/runtime-benchmark/miniflare-server.mjs'
            : 'scripts/runtime-benchmark/server.mjs',
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: 'production',
            HOST: '127.0.0.1',
            PORT: '0',
            ADMIN_TOKEN: 'benchmark-local-admin',
            DATA_DIRECTORY: runDirectory,
            OBJECT_DIRECTORY: join(runDirectory, 'objects'),
            DB_ADAPTER: 'postgres',
            PG_TLS_MODE: 'disable',
            DATABASE_URL: `postgres://postgres:benchmark-local-only@127.0.0.1:${pgPort}/${database}`,
            BENCH_TRANSPORT: variant === 'bun-native' ? 'native' : 'node',
            BENCH_BACKEND_DIRECTORY: backendDirectory,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      active = child
      child.stderr.pipe(log, { end: false })
      let failure
      child.on('error', (error) => {
        failure = error
      })
      child.on('exit', (code, signal) => {
        failure = new Error(`${label} exited ${code ?? signal}`)
      })
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => {
        log.write(`${line}\n`)
        let message
        try {
          message = JSON.parse(line)
        } catch {
          return
        }
        if (!message.benchmark) return
        const waiter = waiters.get(message.type)
        if (waiter) {
          waiters.delete(message.type)
          waiter(message)
        } else messages.set(message.type, message)
      })
      const next = async (type) => {
        if (messages.has(type)) {
          const message = messages.get(type)
          messages.delete(type)
          return message
        }
        let interval
        try {
          return await Promise.race([
            new Promise((resolve) => waiters.set(type, resolve)),
            new Promise((_, reject) => {
              const deadline = Date.now() + 60000
              interval = setInterval(() => {
                if (failure || Date.now() > deadline)
                  reject(failure ?? new Error(`${label} ${type} timeout`))
              }, 50)
            }),
          ])
        } finally {
          clearInterval(interval)
          waiters.delete(type)
        }
      }
      let sampler
      try {
        const ready = await next('ready')
        assert.equal(ready.liveSubscriberLimit, report.capacity.benchmarkLimit)
        console.log(`${label}: ${warmupMs / 1000}s warmup + ${measuredMs / 1000}s measured`)
        const rss = []
        const processRss = Object.fromEntries(
          (ready.metricsProcessRoles ?? []).map((role) => [role, []]),
        )
        const memoryErrors = []
        let databaseCpuStart, databaseCpuUsec
        let driverCpuStart, driverCpu
        let sampling = Promise.resolve()
        const result = await traffic({
          site: `http://127.0.0.1:${ready.port}`,
          adminToken: 'benchmark-local-admin',
          trace,
          fixture,
          dropClaims: process.env.BENCH_DROP_CLAIMS === '1',
          warmupMs,
          durationMs,
          async begin() {
            rss.length = 0
            for (const samples of Object.values(processRss)) samples.length = 0
            driverCpuStart = process.cpuUsage()
            databaseCpuStart = await dbCpu()
            child.stdin.write('begin\n')
            await next('begin')
            sampler = setInterval(() => {
              sampling = sampling
                .then(async () => {
                  const values = await Promise.all(
                    (ready.metricsPids ?? [child.pid]).map(async (pid) => {
                      const status = await readFile(`/proc/${pid}/status`, 'utf8')
                      return Number(status.match(/VmRSS:\s+(\d+)/)[1]) * 1024
                    }),
                  )
                  rss.push(values.reduce((a, b) => a + b, 0))
                  ready.metricsProcessRoles?.forEach((role, index) => {
                    processRss[role].push(values[index])
                  })
                })
                .catch((error) => memoryErrors.push(String(error)))
            }, 250)
          },
          async end() {
            child.stdin.write('end\n')
            const metrics = await next('end')
            driverCpu = process.cpuUsage(driverCpuStart)
            databaseCpuUsec = (await dbCpu()) - databaseCpuStart
            clearInterval(sampler)
            await sampling
            return metrics
          },
        }).catch((error) => {
          if (!error.benchmarkResult?.serverMetrics) throw error
          return error.benchmarkResult
        })
        assert.deepEqual(memoryErrors, [])
        const { raw, serverMetrics, ...measurements } = result
        const cpuSeconds = (serverMetrics.cpu.user + serverMetrics.cpu.system) / 1e6
        const run = {
          repeat: repeat + 1,
          variant,
          runtime: ready.runtime,
          ...measurements,
          durationMs: serverMetrics.elapsedMs,
          backendCpuSeconds: cpuSeconds,
          ...(serverMetrics.processCpuSeconds
            ? { processCpuSeconds: serverMetrics.processCpuSeconds }
            : {}),
          backendCpuPercentOfOneCore: (cpuSeconds / (serverMetrics.elapsedMs / 1000)) * 100,
          databaseCpuSeconds: miniflareOnly ? null : databaseCpuUsec / 1e6,
          driverCpuSeconds: (driverCpu.user + driverCpu.system) / 1e6,
          rssMiB: {
            mean: rss.reduce((a, b) => a + b, 0) / rss.length / 2 ** 20,
            peak: Math.max(...rss) / 2 ** 20,
          },
          ...(miniflareOnly
            ? {
                processRssMiB: Object.fromEntries(
                  Object.entries(processRss).map(([role, samples]) => [
                    role,
                    {
                      mean: samples.reduce((a, b) => a + b, 0) / samples.length / 2 ** 20,
                      peak: Math.max(...samples) / 2 ** 20,
                    },
                  ]),
                ),
              }
            : {}),
          eventLoopDelayMs: distribution(serverMetrics.delaySamples),
        }
        report.runs.push(run)
        await writeFile(
          join(output, `${label}-samples.json`),
          JSON.stringify({ ...raw, rss, processRss, serverMetrics }),
        )
        await save()
        console.log(
          `${label}: CPU ${run.backendCpuSeconds.toFixed(3)}s, RSS ${run.rssMiB.mean.toFixed(1)}MiB, presence p95 ${run.presenceDeliveryMs.p95?.toFixed(1)}ms, paint p95 ${run.latencies['paint-report']?.p95?.toFixed(1)}ms; ${run.correctness.finalPeerSetsAndDrafts ? 'correctness passed' : `FAILED: ${run.correctness.errors[0]}`}`,
        )
      } finally {
        clearInterval(sampler)
        await stopChild(child)
        active = undefined
        log.end()
      }
      if (!miniflareOnly) docker('exec', container, 'dropdb', '-U', 'postgres', database)
      await rm(runDirectory, { recursive: true, force: true })
    }
  }
  report.finishedAt = new Date().toISOString()
  report.passed = report.runs.every(
    (run) =>
      run.correctness.finalPeerSetsAndDrafts &&
      run.correctness.finalClaimsAndOwnership &&
      run.correctness.errors.length === 0 &&
      Object.values(run.correctness.clientDeadlineMisses).every((count) => count === 0),
  )
  await save()
  assert.ok(report.passed, 'Runtime benchmark failed correctness or the five-second deadline')
  console.log(`Saved ${join(output, 'results.json')}`)
} catch (error) {
  report.error = String(error)
  await save()
  throw error
} finally {
  await stopChild(active)
  if (databaseCreated) docker('rm', '-fv', container)
  await rm(directory, { recursive: true, force: true })
}
