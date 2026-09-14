// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: standalone benchmark, never a cached Turbo task.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const variants = (process.env.BENCH_VARIANTS ?? 'node,bun-compat,bun-native').split(',')
const serverCpus = process.env.BENCH_SERVER_CPUS ?? '2,3'
const databaseCpus = process.env.BENCH_DATABASE_CPUS ?? '4,5'
const container = `caelestis-runtime-benchmark-${randomUUID().slice(0, 8)}`
const directory = await mkdtemp(join(tmpdir(), 'caelestis-runtime-benchmark-'))
const fixture = await fixtures(durationMs)
const trace = schedule(durationMs)
const traceJson = JSON.stringify(trace)
await writeFile(join(output, 'trace.json'), traceJson)
const sourceHashes = Object.fromEntries(
  await Promise.all(
    ['run.mjs', 'server.mjs', 'traffic.mjs'].map(async (name) => [
      name,
      createHash('sha256')
        .update(await readFile(new URL(name, import.meta.url)))
        .digest('hex'),
    ]),
  ),
)
const report = {
  sourceHashes,
  issue: 385,
  pr: 351,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(),
  description,
  warmupMs,
  measuredMs,
  repeats,
  transport:
    'production NodeLiveHost and shared coordinators; Bun-native uses a benchmark-only native socket bridge',
  database: 'isolated local PostgreSQL 18, fresh database per run, TLS disabled',
  objects: 'local filesystem; no S3, Traefik, frontend rendering or Wplace HTTP traffic',
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
    tiles: fixture.tiles.map(({ bytes, sha256 }) => ({ bytes: bytes.length, sha256 })),
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
  void stopChild(active).finally(() => {
    if (databaseCreated) docker('rm', '-fv', container)
    process.exit(143)
  })
})
process.once('SIGINT', () => {
  void stopChild(active).finally(() => {
    if (databaseCreated) docker('rm', '-fv', container)
    process.exit(130)
  })
})
try {
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
  databaseCreated = true
  const inspect = JSON.parse(docker('inspect', container))[0]
  const pgPort = inspect.NetworkSettings.Ports['5432/tcp'][0].HostPort
  const group = (await readFile(`/proc/${inspect.State.Pid}/cgroup`, 'utf8'))
    .trim()
    .split('\n')
    .find((line) => line.startsWith('0::'))
    .slice(3)
  const dbCpu = async () =>
    Number((await readFile(`/sys/fs/cgroup${group}/cpu.stat`, 'utf8')).match(/usage_usec (\d+)/)[1])
  report.databaseImage = inspect.Image
  for (let attempt = 0; ; attempt++) {
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
      assert.ok(['node', 'bun-compat', 'bun-native'].includes(variant))
      const label = `${repeat + 1}-${variant}`
      const database = `run_${repeat}_${variant.replaceAll('-', '_')}`
      docker('exec', container, 'createdb', '-U', 'postgres', database)
      const runDirectory = join(directory, label)
      await mkdir(runDirectory)
      const log = createWriteStream(join(output, `${label}.log`))
      const waiters = new Map(),
        messages = new Map()
      const child = spawn(
        'taskset',
        ['-c', serverCpus, variant === 'node' ? node : bun, 'scripts/runtime-benchmark/server.mjs'],
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
        console.log(`${label}: ${warmupMs / 1000}s warmup + ${measuredMs / 1000}s measured`)
        const rss = []
        const memoryErrors = []
        let databaseCpuStart, databaseCpuUsec
        let sampling = Promise.resolve()
        const result = await traffic({
          site: `http://127.0.0.1:${ready.port}`,
          adminToken: 'benchmark-local-admin',
          trace,
          fixture,
          warmupMs,
          durationMs,
          async begin() {
            databaseCpuStart = await dbCpu()
            child.stdin.write('begin\n')
            await next('begin')
            sampler = setInterval(() => {
              sampling = sampling
                .then(async () => {
                  const status = await readFile(`/proc/${child.pid}/status`, 'utf8')
                  rss.push(Number(status.match(/VmRSS:\s+(\d+)/)[1]) * 1024)
                })
                .catch((error) => memoryErrors.push(String(error)))
            }, 250)
          },
          async end() {
            child.stdin.write('end\n')
            const metrics = await next('end')
            databaseCpuUsec = (await dbCpu()) - databaseCpuStart
            clearInterval(sampler)
            await sampling
            return metrics
          },
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
          backendCpuPercentOfOneCore: (cpuSeconds / (serverMetrics.elapsedMs / 1000)) * 100,
          databaseCpuSeconds: databaseCpuUsec / 1e6,
          rssMiB: {
            mean: rss.reduce((a, b) => a + b, 0) / rss.length / 2 ** 20,
            peak: Math.max(...rss) / 2 ** 20,
          },
          eventLoopDelayMs: distribution(serverMetrics.delaySamples),
        }
        report.runs.push(run)
        await writeFile(
          join(output, `${label}-samples.json`),
          JSON.stringify({ ...raw, rss, serverMetrics }),
        )
        await save()
        console.log(
          `${label}: CPU ${run.backendCpuSeconds.toFixed(3)}s, RSS ${run.rssMiB.mean.toFixed(1)}MiB, presence p95 ${run.presenceDeliveryMs.p95?.toFixed(1)}ms, paint p95 ${run.latencies['paint-report']?.p95?.toFixed(1)}ms; correctness passed`,
        )
      } finally {
        clearInterval(sampler)
        await stopChild(child)
        active = undefined
        log.end()
      }
      docker('exec', container, 'dropdb', '-U', 'postgres', database)
      await rm(runDirectory, { recursive: true, force: true })
    }
  }
  report.finishedAt = new Date().toISOString()
  await save()
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
