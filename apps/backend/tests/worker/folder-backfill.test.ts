import {
  encodeIndexedPng,
  type FolderBackfillJob,
  type FolderBackfillPreview,
  TILE_SIZE,
} from '@caelestis/shared'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ARCHIVE_ADMIN } from '../support/archive.js'
import { bundleWorker, openCloudflare } from '../support/cloudflare.js'
import { archiveWeek } from '../support/eralyon.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

let worker = ''
beforeAll(async () => {
  worker = await bundleWorker()
}, 60_000)

/** Every tile reads archive colour 2 at the first snapshot and 3 at the second. */
const eralyon = (downloads: Map<string, number>) => {
  const week = archiveWeek([
    [1, new Uint8Array(TILE_SIZE * TILE_SIZE).fill(2)],
    [2, new Uint8Array(TILE_SIZE * TILE_SIZE).fill(3)],
  ])
  return (request: Request): Response => {
    const { pathname } = new URL(request.url)
    downloads.set(pathname, (downloads.get(pathname) ?? 0) + 1)
    if (pathname === '/en/')
      return new Response("const WPLACE_VERSIONS = [{ version: '1' }, { version: '2' }]")
    return new Response(week)
  }
}

describe('Cloudflare folder backfill', { timeout: 120_000 }, () => {
  it('imports every template below a folder into its own history, reading each tile once', async () => {
    const downloads = new Map<string, number>()
    const cloudflare = await openCloudflare(worker, eralyon(downloads))
    cleanups.push(cloudflare.dispose)
    const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const response = await cloudflare.fetch(`${cloudflare.api}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${ARCHIVE_ADMIN}`, ...init.headers },
      })
      const text = await response.text()
      expect(response.ok, `${path}: ${text}`).toBe(true)
      return JSON.parse(text) as T
    }
    const json = (body: unknown) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const folder = await call<{ id: string }>(
      '/admin/nodes',
      json({ season: 0, parentId: null, name: 'Murals' }),
    )
    const child = await call<{ id: string }>(
      '/admin/nodes',
      json({ season: 0, parentId: folder.id, name: 'North' }),
    )
    // One template per palette colour the archive shows, on neighbouring tiles.
    const templates: string[] = []
    for (const [index, nodeId] of [folder.id, child.id].entries()) {
      const form = new FormData()
      form.set(
        'png',
        new File([await encodeIndexedPng(1, 1, new Uint8Array([index + 1]))], 'a.png'),
      )
      form.set('nodeId', nodeId)
      form.set('name', `Mural ${index + 1}`)
      form.set('originX', String(index * TILE_SIZE))
      form.set('originY', '0')
      const created = await call<{ templateId: string }>('/admin/templates', {
        method: 'POST',
        body: form,
      })
      templates.push(created.templateId)
    }

    const preview = await call<FolderBackfillPreview>(
      `/admin/backfill/folders/${folder.id}/preview`,
    )
    expect(preview.bases).toHaveLength(2)
    const started = await call<FolderBackfillJob>(
      `/admin/backfill/folders/${folder.id}/start`,
      json({
        versionIds: preview.bases.map((basis) => basis.versionId),
        snapshotId: preview.snapshots[0]?.id,
      }),
    )
    let job: FolderBackfillJob | null = started
    while (job?.status === 'running')
      job = await call<FolderBackfillJob | null>(`/admin/backfill/folders/${folder.id}/job`)

    expect(job).toMatchObject({ status: 'completed', imported: started.total, failed: 0 })
    // Both templates' tiles came from one download each.
    const tiles = [...downloads].filter(([path]) => path.startsWith('/tiles/'))
    expect(tiles).toHaveLength(preview.tileCount)
    expect(tiles.every(([, count]) => count === 1)).toBe(true)
    const histories = await Promise.all(
      templates.map((id) =>
        call<{ samples: { correct: number; mismatched: number }[] }>(`/archive/templates/${id}`),
      ),
    )
    expect(histories.map((history) => history.samples)).toMatchObject([
      [
        { correct: 1, mismatched: 0 },
        { correct: 0, mismatched: 1 },
      ],
      [
        { correct: 0, mismatched: 1 },
        { correct: 1, mismatched: 0 },
      ],
    ])
  })
})
