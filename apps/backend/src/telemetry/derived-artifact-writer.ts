import type { BlobStore } from '../ports/index.js'
import { type MismatchArtifactIdentity, mismatchArtifactKey } from './derived-classification.js'

export interface DerivedArtifactWrite {
  readonly identity: MismatchArtifactIdentity
  readonly bytes: Uint8Array
}

export interface DerivedArtifactWriterOptions {
  /** Queued bytes above this are dropped, newest first. Reads rebuild a missing artifact. */
  readonly maxQueuedBytes?: number
  readonly maxQueuedEntries?: number
  /** Concurrent object-storage writes across every request on this runtime. */
  readonly concurrency?: number
  readonly onError?: (error: unknown, write: DerivedArtifactWrite) => void
  readonly onDropped?: (write: DerivedArtifactWrite) => void
}

export interface DerivedArtifactWriterStats {
  readonly queuedEntries: number
  readonly queuedBytes: number
  readonly inFlight: number
  readonly written: number
  readonly failed: number
  readonly dropped: number
  readonly coalesced: number
}

export interface DerivedArtifactWriter {
  /**
   * Queue reconstructible writes and return at once. Identical immutable keys already queued are
   * not queued twice. Nothing here can fail a caller: overflow drops, errors are reported.
   */
  readonly schedule: (blobs: BlobStore, writes: readonly DerivedArtifactWrite[]) => void
  /** Resolve once every queued and in-flight write has settled. Shutdown and tests wait on this. */
  readonly drain: () => Promise<void>
  readonly stats: () => DerivedArtifactWriterStats
}

export const DEFAULT_DERIVED_ARTIFACT_QUEUE_BYTES = 64 * 1024 * 1024
export const DEFAULT_DERIVED_ARTIFACT_QUEUE_ENTRIES = 256
export const DEFAULT_DERIVED_ARTIFACT_CONCURRENCY = 4

interface QueuedWrite extends DerivedArtifactWrite {
  readonly blobs: BlobStore
  readonly key: string
}

/**
 * Live commands used to wait for these writes after their authoritative work had committed, so a
 * slow object store stretched every reply. Masks are derived from durable inputs and keyed by
 * every input that shapes them, so a lost write only costs a later rebuild. This writer owns the
 * bound on queued bytes, entries, and concurrency across all requests on the runtime.
 */
export const createDerivedArtifactWriter = (
  options: DerivedArtifactWriterOptions = {},
): DerivedArtifactWriter => {
  const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_DERIVED_ARTIFACT_QUEUE_BYTES
  const maxQueuedEntries = options.maxQueuedEntries ?? DEFAULT_DERIVED_ARTIFACT_QUEUE_ENTRIES
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_DERIVED_ARTIFACT_CONCURRENCY)
  const onError =
    options.onError ??
    ((error: unknown) => console.error('failed to persist derived mismatch artifact', error))
  const onDropped = options.onDropped ?? (() => {})

  const queue: QueuedWrite[] = []
  const queuedKeys = new Set<string>()
  let queuedBytes = 0
  let inFlight = 0
  let written = 0
  let failed = 0
  let dropped = 0
  let coalesced = 0
  let idle: { promise: Promise<void>; resolve: () => void } | null = null

  const settleIfIdle = () => {
    if (queue.length === 0 && inFlight === 0 && idle !== null) {
      idle.resolve()
      idle = null
    }
  }

  const pump = () => {
    while (inFlight < concurrency) {
      const next = queue.shift()
      if (next === undefined) break
      queuedBytes -= next.bytes.byteLength
      inFlight += 1
      next.blobs
        .put('derived', next.key, next.bytes)
        .then(
          () => {
            written += 1
          },
          (error: unknown) => {
            failed += 1
            try {
              onError(error, next)
            } catch {
              // A failing error hook must not stop the queue.
            }
          },
        )
        .finally(() => {
          // The key stays reserved while in flight so a repeat of the same immutable artifact
          // coalesces instead of writing twice.
          queuedKeys.delete(next.key)
          inFlight -= 1
          pump()
          settleIfIdle()
        })
    }
    settleIfIdle()
  }

  return {
    schedule: (blobs, writes) => {
      for (const write of writes) {
        const key = mismatchArtifactKey(write.identity)
        if (queuedKeys.has(key)) {
          coalesced += 1
          continue
        }
        if (
          queue.length >= maxQueuedEntries ||
          queuedBytes + write.bytes.byteLength > maxQueuedBytes
        ) {
          dropped += 1
          onDropped(write)
          continue
        }
        queue.push({ ...write, blobs, key })
        queuedKeys.add(key)
        queuedBytes += write.bytes.byteLength
        // Start free workers at once so the bound counts waiting work, not work already running.
        pump()
      }
    },
    drain: () => {
      if (queue.length === 0 && inFlight === 0) return Promise.resolve()
      if (idle === null) {
        let resolve = () => {}
        const promise = new Promise<void>((done) => {
          resolve = done
        })
        idle = { promise, resolve }
      }
      return idle.promise
    },
    stats: () => ({
      queuedEntries: queue.length,
      queuedBytes,
      inFlight,
      written,
      failed,
      dropped,
      coalesced,
    }),
  }
}

/** One writer per runtime: the bound applies across requests, not per job. */
export const derivedArtifactWriter = createDerivedArtifactWriter()
