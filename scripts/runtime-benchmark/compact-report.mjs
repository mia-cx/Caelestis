#!/usr/bin/env node
// Turn a raw stack-test benchmark report into one entry of a compact results file such as
// docs/benchmarks/tile-processing-cnpg-s3-2026-09-18.json, keeping counts, latencies, stage
// timings, correctness, and measured-phase resources, and dropping raw samples.
//
//   node scripts/runtime-benchmark/compact-report.mjs --name node-ladder-256 \
//     --revision fd335e90 --change 'Batches leave the coordinator lane' \
//     path/to/caelestis-test-cnpg-s3-xxxx/benchmark.json > run.json
import { readFileSync } from 'node:fs'

const options = {}
const positional = []
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index++) {
  const argument = argv[index]
  if (argument.startsWith('--')) options[argument.slice(2)] = argv[++index]
  else positional.push(argument)
}
const [reportPath] = positional
if (!reportPath || !options.name || !options.revision) {
  console.error('usage: compact-report.mjs --name NAME --revision SHA [--change TEXT] REPORT.json')
  process.exit(2)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const result = report.result ?? {}
const round = (value, digits = 1) =>
  typeof value === 'number' ? Number(value.toFixed(digits)) : value
const summary = (sample) =>
  sample && {
    count: sample.count,
    p50: round(sample.p50),
    p95: round(sample.p95),
    p99: round(sample.p99),
    max: round(sample.max),
  }
const backend = report.containers?.find((container) => container.name === 'backend')
const backendImage = backend?.image?.replace(/^docker\.io\/library\//, '') ?? null
const runtime = backendImage?.includes(':bun-')
  ? { bun: report.runtime?.bun }
  : { node: report.runtime?.node }
const metrics = result.serverMetrics
const serverMetrics = metrics && {
  durationMs: metrics.durationMs,
  backend: metrics.backend,
  fullStack: metrics.fullStack,
  containers: metrics.containers?.map((container) => ({
    name: container.name,
    node: container.node,
    image: container.image,
    cpuPercent: round(container.cpuPercent, 2),
    limits: container.resources?.limits,
  })),
}

const run = {
  name: options.name,
  namespace: report.namespace,
  startedAt: report.startedAt,
  applicationRevision: options.revision,
  backendImage,
  change: options.change ?? null,
  // The configured trace size, not the count online at the end, which a failed run cuts short.
  users: report.description?.users ?? null,
  runtime,
  passed: report.passed === true,
  completed: result.phase === 'measured' && report.error == null,
  failure: report.error ? String(report.error.message ?? report.error).split('\n')[0] : null,
  phase: result.phase ?? null,
  commandTimeoutMs: report.commandTimeoutMs,
  sent: result.sent,
  received: result.received,
  latenciesMs: Object.fromEntries(
    Object.entries(result.latencies ?? {}).map(([name, sample]) => [name, summary(sample)]),
  ),
  presenceDeliveryMs: summary(result.presenceDeliveryMs),
  correctness: result.correctness,
  backendStages: result.backendStages,
  serverMetrics: serverMetrics ?? null,
}
process.stdout.write(`${JSON.stringify(run, null, 2)}\n`)
