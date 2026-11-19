import type { BlobStore } from '../ports/index.js'
import {
  type ClassificationKey,
  logArtifactFailure,
  mismatchArtifactKey,
  putMismatchArtifact,
} from './derived-artifacts.js'

export interface DerivedArtifactWrite {
  readonly identity: ClassificationKey
  readonly bytes: Uint8Array
}

export interface DerivedArtifactWriterOptions {
  /** Queued bytes above this are dropped, newest first. Reads rebuild a missing artifact. */
  readonly maxQueuedBytes?: number
  readonly maxQueuedEntries?: number
  /** Concurrent object-storage writes across every caller of this writer. */
  readonly concurrency?: number
  readonly onError?: (error: unknown, write: DerivedArtifactWrite) => void
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
   * Queue writes and return at once. An immutable key already queued or in flight is not queued
   * twice. Nothing here can fail a caller: overflow drops, errors go to `onError`.
   */
  readonly schedule: (blobs: BlobStore, writes: readonly DerivedArtifactWrite[]) => void
  /** Resolve once every queued and in-flight write has settled. */
  readonly drain: () => Promise<void>
  readonly stats: () => DerivedArtifactWriterStats
}

const DEFAULT_QUEUE_BYTES = 64 * 1024 * 1024
const DEFAULT_QUEUE_ENTRIES = 256
const DEFAULT_CONCURRENCY = 4

interface QueuedWrite extends DerivedArtifactWrite {
  readonly blobs: BlobStore
  readonly key: string
}

/**
 * A bounded background queue for derived mask writes, so a slow object store never stretches a
 * reply. It owns the bound on queued bytes, entries, and concurrency across all its callers.
 */
export const createDerivedArtifactWriter = (
  options: DerivedArtifactWriterOptions = {},
): DerivedArtifactWriter => {
  const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_QUEUE_BYTES
  const maxQueuedEntries = options.maxQueuedEntries ?? DEFAULT_QUEUE_ENTRIES
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
  const onError = options.onError ?? logArtifactFailure

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
      putMismatchArtifact(next.blobs, next.identity, next.bytes)
        .then(
          () => {
            written += 1
          },
          (error: unknown) => {
            failed += 1
            try {
              onError(error, next)
            } catch (hookError) {
              // A failing hook must not stop the queue.
              console.error('derived artifact error hook failed', hookError)
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

/**
 * One writer per isolate, at module scope because concurrent Worker requests share nothing else,
 * so its bound applies across requests. Hosts drain it before shutdown.
 */
export const derivedArtifactWriter = createDerivedArtifactWriter()

export interface DerivedArtifactWriteBatch {
  /** Queue one write while this job still has artifact allowance. */
  readonly add: (identity: ClassificationKey, bytes: Uint8Array) => void
  /** Hand the queued writes to the writer, after the authoritative work has published. */
  readonly flush: () => void
}

/** Leave most of the Worker's 1,000 internal-service subrequests for authoritative D1/R2 work. */
const MAX_DERIVED_ARTIFACT_WRITES_PER_JOB = 64

export const createDerivedArtifactWriteBatch = (
  blobs: BlobStore,
  writer: DerivedArtifactWriter,
): DerivedArtifactWriteBatch => {
  const queued: DerivedArtifactWrite[] = []
  let remaining = MAX_DERIVED_ARTIFACT_WRITES_PER_JOB
  return {
    add: (identity, bytes) => {
      if (remaining === 0) return
      remaining--
      queued.push({ identity, bytes })
    },
    flush: () => writer.schedule(blobs, queued.splice(0)),
  }
}
