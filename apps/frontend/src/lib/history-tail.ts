import { type HistoryBucket, type Seconds, seconds } from '@caelestis/shared'

/** What the history routes answer: buckets on one grid, with that grid's width when bounded. */
export interface HistoryRead<Bucket extends HistoryBucket = HistoryBucket> {
  readonly resolution?: number
  readonly coverageStart?: Seconds
  readonly buckets: readonly Bucket[]
}

/** One history read kept current as its end advances. */
export interface HeldHistory<Read extends HistoryRead> {
  /** What was read: a new key needs a full read. */
  readonly key: string
  readonly to: number
  readonly read: Read
}

/**
 * How long after a bucket starts the server may still change it: counters reach storage 90 s after
 * their minute and accept late reports for an hour after that (the backend's
 * `EXPIRES_AFTER_SECONDS`).
 */
const MUTABLE_SECONDS = 3_690

/**
 * Bring a held history up to `to`, reading only what changed.
 *
 * A new key, or nothing held yet, reads `[from, to)` in full. Otherwise only the buckets the server
 * can still have changed since the last read are read again. The server answers that recent range
 * at the full read's resolution or a finer tier, and the finer buckets are summed onto the full
 * read's grid, the same fold the server applies across tiers.
 *
 * `read(start, maxResolution)` reads `[start, to)`; `maxResolution` is unset for a full read.
 */
export const refreshHistory = async <Read extends HistoryRead>(
  held: HeldHistory<Read> | null,
  key: string,
  from: number,
  to: number,
  read: (start: number, maxResolution: number | undefined) => Promise<Read>,
): Promise<HeldHistory<Read>> => {
  const resolution =
    held?.key === key ? (held.read.resolution ?? held.read.buckets[0]?.resolution) : undefined
  if (held === null || resolution === undefined)
    return { key, to, read: await read(from, undefined) }

  const tailStart = Math.max(
    from,
    Math.floor((held.to - MUTABLE_SECONDS) / resolution) * resolution,
  )
  const tail = await read(tailStart, resolution)
  const folded = new Map<string, Read['buckets'][number]>()
  for (const bucket of tail.buckets) {
    const bucketStart = seconds(Math.floor(bucket.bucketStart / resolution) * resolution)
    const painter = 'wplaceUserId' in bucket ? bucket.wplaceUserId : ''
    const foldKey = `${bucket.templateId}\0${painter}\0${bucketStart}`
    const into = folded.get(foldKey)
    folded.set(foldKey, {
      ...bucket,
      resolution,
      bucketStart,
      placed: (into?.placed ?? 0) + bucket.placed,
      correct: (into?.correct ?? 0) + bucket.correct,
      repairs: (into?.repairs ?? 0) + bucket.repairs,
    })
  }
  const kept = held.read.buckets.filter((bucket) => bucket.bucketStart < tailStart)
  return { key, to, read: { ...held.read, buckets: [...kept, ...folded.values()] } }
}
