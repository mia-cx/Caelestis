import { ALARM_SCAN_INTERVAL_SECONDS } from '../telemetry/alarm-policy.js'
import { type FetcherStores, fetchCanvasTiles } from '../telemetry/fetcher.js'
import { runTileBlobGc } from '../telemetry/tile-blobs.js'
import type { ServerConfig } from './config.js'

const SIX_HOURS = ALARM_SCAN_INTERVAL_SECONDS * 1_000
const DAY = 24 * 60 * 60 * 1_000

/**
 * Every periodic job. The Worker runs a job when Cloudflare fires its cron, which wrangler.toml
 * `[triggers]` must list; Node runs it `every` milliseconds after the previous run.
 */
export const JOBS = {
  /** Refetch template tiles and their surroundings, so timelapses keep moving. */
  mirror: { cron: '0 */6 * * *', every: SIX_HOURS },
  /** Expire region claims and reclaim unreferenced tile blobs. */
  gc: { cron: '0 */6 * * *', every: SIX_HOURS },
  /** Render each published template's share GIF. */
  social: { cron: '37 7 * * *', every: DAY },
} as const satisfies Record<string, { readonly cron: string; readonly every: number }>

export type JobName = keyof typeof JOBS

export const JOB_NAMES = Object.keys(JOBS) as readonly JobName[]

/** The jobs a Worker cron trigger starts. */
export const jobsAt = (cron: string): readonly JobName[] =>
  JOB_NAMES.filter((name) => JOBS[name].cron === cron)

/** The jobs both hosts run the same way. Social refresh renders per host. */
export const portableJobs = (
  stores: FetcherStores,
  config: Pick<ServerConfig, 'season' | 'tileGc'>,
  scheduleAlarms: () => Promise<void>,
) => ({
  mirror: async (): Promise<void> => {
    try {
      await fetchCanvasTiles(stores, { season: config.season })
    } finally {
      // A template may already have persisted a probe when later scan work fails. Always
      // reconcile the alarm so that durable work cannot be stranded until the next run.
      await scheduleAlarms()
    }
  },
  gc: async (): Promise<void> => {
    await Promise.all([
      stores.sql.regions.expireRegions(Date.now()),
      runTileBlobGc(stores, { mode: config.tileGc }),
    ])
  },
})
