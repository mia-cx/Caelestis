import { encodeIndexedPng, seconds, sha256Hex, TRANSPARENT_INDEX } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { MemoryBlobStore } from '../src/adapters/memory/memory-blob-store.js'
import type { BlobStore } from '../src/ports/index.js'
import { createBackendRuntime, makeBackendContext } from '../src/runtime/backend-runtime.js'
import { readMismatchMask, uploadTile } from '../src/telemetry/ingest.js'
import { authorized, createTestBackend } from './support/backend.js'
import { openRelationalStore } from './support/relational.js'

it('recovers a failed object upload, preserving each reporter observation without duplicating stored bytes', async () => {
  const opened = await openRelationalStore()
  try {
    const { app, sql, blobs, counters } = await createTestBackend({ sql: opened.sql })
    const form = new FormData()
    form.set('png', new File([await encodeIndexedPng(2, 1, new Uint8Array([1, 2]))], 'art.png'))
    form.set('name', 'Recovery')
    form.set('season', '3')
    form.set('originX', '0')
    form.set('originY', '0')
    const created = await app.fetch(authorized('/admin/templates', { method: 'POST', body: form }))
    expect(created.status).toBe(201)
    const { templateId, versionId } = (await created.json()) as {
      templateId: string
      versionId: string
    }
    let fail = true
    // Object storage is the external failure boundary. SQL and classification stay real.
    class RecoveringObjects extends MemoryBlobStore {
      override async put(...args: Parameters<BlobStore['put']>) {
        if (args[0] === 'tiles' && fail) {
          fail = false
          throw new Error('object store unavailable')
        }
        return blobs.put(...args)
      }
      override get(...args: Parameters<BlobStore['get']>) {
        return blobs.get(...args)
      }
    }
    const runtime = createBackendRuntime(makeBackendContext(new RecoveringObjects(), sql, counters))
    const pixels = new Uint8Array(1_000_000).fill(TRANSPARENT_INDEX)
    pixels.set([1, 3])
    const bytes = await encodeIndexedPng(1000, 1000, pixels)
    const hash = await sha256Hex(bytes)
    const at = Math.floor(Date.now() / 1000)
    const metadata = (reporter: number) => ({
      season: 3,
      tile: { x: 0, y: 0 },
      hash,
      observedAt: seconds(at + reporter),
      includeUnpublished: true,
      tokenHash: String(reporter).padStart(64, '0'),
      wplaceUserId: reporter,
      displayName: `Reporter ${reporter}`,
    })
    await expect(runtime.run(uploadTile(metadata(1), bytes))).rejects.toThrow()
    await runtime.run(uploadTile(metadata(1), bytes))
    await runtime.run(uploadTile(metadata(2), bytes))
    expect(await sql.readTemplateStatuses(3, true)).toMatchObject([
      { total: 2, correct: 1, wrong: 1, blank: 0 },
    ])
    expect(
      await sql.readTileHistory({
        season: 3,
        tile: { x: 0, y: 0 },
        resolution: 0,
        fromSeconds: seconds(at),
        toSeconds: seconds(at + 3),
      }),
    ).toHaveLength(2)
    const stored = await sql.readTileBlob(hash)
    expect(stored?.state).toBe('active')
    expect(await blobs.get('tiles', stored?.blobKey ?? '')).toEqual(bytes)
    const mask = await runtime.run(
      readMismatchMask({
        season: 3,
        templateId,
        versionId,
        tile: { x: 0, y: 0 },
        includeUnpublished: true,
      }),
    )
    expect(mask.kind).toBe('found')
  } finally {
    await opened.close()
  }
})
