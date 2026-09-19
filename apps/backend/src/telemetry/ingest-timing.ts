/** Live commands, plus `sql` for the database adapter's own waits behind them. */
export type IngestCommand = 'upload' | 'offer' | 'paint' | 'sql'

export type IngestStage =
  | 'queue'
  | 'poolWait'
  | 'statement'
  | 'transaction'
  | 'retry'
  | 'hash'
  | 'targets'
  | 'reserve'
  | 'blobPut'
  | 'decode'
  | 'prepare'
  | 'classify'
  | 'painter'
  | 'commit'
  | 'projection'
  | 'alarms'
  | 'artifacts'
  | 'historyFold'
  | 'latestTile'
  | 'apply'
  | 'counters'
  | 'total'

export interface StageSummary {
  readonly count: number
  readonly totalMs: number
  readonly maxMs: number
  readonly p50Ms: number
  readonly p99Ms: number
}

export interface IngestTimingSnapshot {
  readonly since: number
  readonly commands: Readonly<
    Record<IngestCommand, Readonly<Partial<Record<IngestStage, StageSummary>>>>
  >
  readonly counters: Readonly<Record<string, number>>
}

const SAMPLE_WINDOW = 512

interface StageAccumulator {
  count: number
  totalMs: number
  maxMs: number
  readonly recent: Float64Array
  next: number
}

const percentile = (sorted: readonly number[], fraction: number): number => {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index] ?? 0
}

const summarize = (accumulator: StageAccumulator): StageSummary => {
  const held = Math.min(accumulator.count, SAMPLE_WINDOW)
  const sorted = Array.from(accumulator.recent.subarray(0, held)).sort(
    (left, right) => left - right,
  )
  return {
    count: accumulator.count,
    totalMs: Math.round(accumulator.totalMs * 1_000) / 1_000,
    maxMs: Math.round(accumulator.maxMs * 1_000) / 1_000,
    p50Ms: Math.round(percentile(sorted, 0.5) * 1_000) / 1_000,
    p99Ms: Math.round(percentile(sorted, 0.99) * 1_000) / 1_000,
  }
}

/**
 * Where live commands spend their time, per stage, on this runtime.
 *
 * The #397 profile showed classification as the largest CPU consumer but said nothing about
 * queueing, database, or object-storage waits. Every stage of an upload, offer, or paint is
 * recorded here in process, with the last 512 samples per stage for percentiles, so a benchmark
 * can read the breakdown without a debugger attached. This is observability only; it never
 * changes what a command does.
 */
export class IngestTimings {
  private readonly stages = new Map<string, StageAccumulator>()
  private readonly counts = new Map<string, number>()
  private since: number

  constructor(private readonly now: () => number = () => performance.now()) {
    this.since = Date.now()
  }

  record(command: IngestCommand, stage: IngestStage, durationMs: number): void {
    const key = `${command}.${stage}`
    let accumulator = this.stages.get(key)
    if (accumulator === undefined) {
      accumulator = {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        recent: new Float64Array(SAMPLE_WINDOW),
        next: 0,
      }
      this.stages.set(key, accumulator)
    }
    accumulator.count += 1
    accumulator.totalMs += durationMs
    if (durationMs > accumulator.maxMs) accumulator.maxMs = durationMs
    accumulator.recent[accumulator.next] = durationMs
    accumulator.next = (accumulator.next + 1) % SAMPLE_WINDOW
  }

  /** Count an event that has no duration, such as a shared-classification hit. */
  count(name: string, by = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + by)
  }

  /** Time one stage of a command; the stage is recorded whether or not the work throws. */
  async timed<Value>(
    command: IngestCommand,
    stage: IngestStage,
    run: () => Promise<Value>,
  ): Promise<Value> {
    const startedAt = this.now()
    try {
      return await run()
    } finally {
      this.record(command, stage, this.now() - startedAt)
    }
  }

  snapshot(): IngestTimingSnapshot {
    const commands: Record<IngestCommand, Partial<Record<IngestStage, StageSummary>>> = {
      upload: {},
      offer: {},
      paint: {},
      sql: {},
    }
    for (const [key, accumulator] of this.stages) {
      const [command, stage] = key.split('.') as [IngestCommand, IngestStage]
      commands[command][stage] = summarize(accumulator)
    }
    return { since: this.since, commands, counters: Object.fromEntries(this.counts) }
  }

  reset(): void {
    this.stages.clear()
    this.counts.clear()
    this.since = Date.now()
  }
}

export const ingestTimings = new IngestTimings()
