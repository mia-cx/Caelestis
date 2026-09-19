import { describe, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import type { BlobStore } from '../ports/index.js'
import {
  createDerivedArtifactWriter,
  type DerivedArtifactWrite,
} from './derived-artifact-writer.js'
import { createDerivedArtifactWriteBatch, mismatchArtifactKey } from './derived-classification.js'

const write = (canvasHash: string, bytes = 4): DerivedArtifactWrite => ({
  identity: {
    templateId: 'template-a',
    versionId: 'version-a',
    tile: { x: 1, y: 2 },
    canvasHash: canvasHash.repeat(64),
  },
  bytes: new Uint8Array(bytes).fill(canvasHash.charCodeAt(0)),
})

const deferred = () => {
  let resolve = () => {}
  let reject = (_error: unknown) => {}
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('derived artifact writer', () => {
  it('returns at once and persists the queued artifacts in the background', async () => {
    const blobs = new MemoryBlobStore()
    const writer = createDerivedArtifactWriter()

    writer.schedule(blobs, [write('a'), write('b')])
    expect(writer.stats()).toMatchObject({ written: 0 })
    await writer.drain()

    expect(writer.stats()).toMatchObject({ written: 2, failed: 0, queuedEntries: 0, inFlight: 0 })
    expect(await blobs.get('derived', mismatchArtifactKey(write('a').identity))).toEqual(
      write('a').bytes,
    )
    expect(await blobs.get('derived', mismatchArtifactKey(write('b').identity))).toEqual(
      write('b').bytes,
    )
  })

  it('bounds concurrent writes across requests and coalesces a key already queued', async () => {
    const gates = [deferred(), deferred(), deferred()]
    let started = 0
    const blobs = {
      put: vi.fn(async () => {
        const gate = gates[started]
        started += 1
        await gate?.promise
      }),
    } as unknown as BlobStore
    const writer = createDerivedArtifactWriter({ concurrency: 2 })

    writer.schedule(blobs, [write('a'), write('b')])
    writer.schedule(blobs, [write('c'), write('b')])
    await Promise.resolve()

    expect(blobs.put).toHaveBeenCalledTimes(2)
    expect(writer.stats()).toMatchObject({ inFlight: 2, queuedEntries: 1, coalesced: 1 })

    gates[0]?.resolve()
    await vi.waitFor(() => expect(blobs.put).toHaveBeenCalledTimes(3))
    gates[1]?.resolve()
    gates[2]?.resolve()
    await writer.drain()
    expect(writer.stats()).toMatchObject({ written: 3, inFlight: 0, queuedEntries: 0 })
  })

  it('drops the newest writes past its byte and entry bounds instead of growing', async () => {
    const gate = deferred()
    const blobs = { put: vi.fn(() => gate.promise) } as unknown as BlobStore
    const dropped: DerivedArtifactWrite[] = []
    const writer = createDerivedArtifactWriter({
      concurrency: 1,
      maxQueuedEntries: 2,
      maxQueuedBytes: 10,
      onDropped: (write) => dropped.push(write),
    })

    // The first write goes in flight; the next two fill the queue; the rest are dropped.
    writer.schedule(blobs, [write('a'), write('b'), write('c', 6), write('d'), write('e', 5)])

    expect(writer.stats()).toMatchObject({ inFlight: 1, queuedEntries: 2, dropped: 2 })
    expect(dropped.map((write) => write.identity.canvasHash[0])).toEqual(['d', 'e'])
    gate.resolve()
    await writer.drain()
    expect(writer.stats()).toMatchObject({ written: 3, dropped: 2 })
  })

  it('reports a failed write and keeps serving the rest of the queue', async () => {
    const errors: unknown[] = []
    let calls = 0
    const blobs = {
      put: vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new Error('bucket unavailable')
      }),
    } as unknown as BlobStore
    const writer = createDerivedArtifactWriter({
      concurrency: 1,
      onError: (error) => errors.push(error),
    })

    writer.schedule(blobs, [write('a'), write('b')])
    await writer.drain()

    expect(errors).toEqual([new Error('bucket unavailable')])
    expect(writer.stats()).toMatchObject({ written: 1, failed: 1, queuedEntries: 0 })
  })

  it('resolves drain immediately when nothing is pending', async () => {
    const writer = createDerivedArtifactWriter()
    await expect(writer.drain()).resolves.toBeUndefined()
  })

  it('lets a job batch flush return before a slow object store has accepted its writes', async () => {
    const gate = deferred()
    const blobs = { put: vi.fn(() => gate.promise) } as unknown as BlobStore
    const writer = createDerivedArtifactWriter()
    const batch = createDerivedArtifactWriteBatch(blobs, { writer })
    batch.add(write('a').identity, write('a').bytes)

    let flushed = false
    const flushing = batch.flush().then(() => {
      flushed = true
    })
    await Promise.resolve()
    expect(flushed).toBe(true)
    expect(writer.stats()).toMatchObject({ inFlight: 1 })

    gate.resolve()
    await flushing
    await writer.drain()
    expect(writer.stats()).toMatchObject({ written: 1 })
  })
})
