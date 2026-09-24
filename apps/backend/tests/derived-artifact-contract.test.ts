import { expect, it } from 'vitest'
import { MemoryBlobStore } from '../src/adapters/memory/memory-blob-store.js'
import type { BlobStore } from '../src/ports/index.js'
import {
  createDerivedArtifactWriter,
  type DerivedArtifactWrite,
} from '../src/telemetry/derived-artifact-writer.js'
import {
  createDerivedArtifactWriteBatch,
  mismatchArtifactKey,
} from '../src/telemetry/derived-classification.js'

const artifact = (hash: string): DerivedArtifactWrite => ({
  identity: {
    templateId: 'art',
    versionId: 'version',
    tile: { x: 0, y: 0 },
    canvasHash: hash.repeat(64),
  },
  bytes: new Uint8Array([hash.charCodeAt(0)]),
})

it('acknowledges a derived batch before storage completes, bounds its queue, and preserves accepted bytes', async () => {
  const gate = Promise.withResolvers<void>()
  class SlowObjects extends MemoryBlobStore {
    override async put(...args: Parameters<BlobStore['put']>) {
      await gate.promise
      await super.put(...args)
    }
  }
  const blobs = new SlowObjects()
  const writer = createDerivedArtifactWriter({
    concurrency: 1,
    maxQueuedEntries: 1,
    maxQueuedBytes: 1,
  })
  const batch = createDerivedArtifactWriteBatch(blobs, { writer })
  // The same immutable key coalesces while in flight. One waiting byte fits; the newest drops.
  const writes = [artifact('a'), artifact('a'), artifact('b'), artifact('c')]
  for (const write of writes) batch.add(write.identity, write.bytes)
  await batch.flush()
  expect(writer.stats()).toMatchObject({
    inFlight: 1,
    queuedEntries: 1,
    queuedBytes: 1,
    coalesced: 1,
    dropped: 1,
  })
  gate.resolve()
  await writer.drain()
  expect(await blobs.get('derived', mismatchArtifactKey(artifact('a').identity))).toEqual(
    artifact('a').bytes,
  )
  expect(await blobs.get('derived', mismatchArtifactKey(artifact('b').identity))).toEqual(
    artifact('b').bytes,
  )
  expect(await blobs.get('derived', mismatchArtifactKey(artifact('c').identity))).toBeNull()
  expect(writer.stats()).toMatchObject({
    inFlight: 0,
    queuedEntries: 0,
    queuedBytes: 0,
    written: 2,
  })
})

it('reports failed derived storage without stopping later work and permits rebuilding the missing key', async () => {
  let failed = false
  class RecoveringObjects extends MemoryBlobStore {
    override async put(...args: Parameters<BlobStore['put']>) {
      if (!failed) {
        failed = true
        throw new Error('storage unavailable')
      }
      await super.put(...args)
    }
  }
  const errors: unknown[] = []
  const writer = createDerivedArtifactWriter({
    concurrency: 1,
    onError: (error) => {
      errors.push(error)
    },
  })
  const blobs = new RecoveringObjects()
  writer.schedule(blobs, [artifact('a'), artifact('b')])
  await writer.drain()
  expect(errors).toEqual([new Error('storage unavailable')])
  expect(await blobs.get('derived', mismatchArtifactKey(artifact('b').identity))).toEqual(
    artifact('b').bytes,
  )
  writer.schedule(blobs, [artifact('a')])
  await writer.drain()
  expect(await blobs.get('derived', mismatchArtifactKey(artifact('a').identity))).toEqual(
    artifact('a').bytes,
  )
})
