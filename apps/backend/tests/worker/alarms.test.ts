import { encodeIndexedPng, sha256Hex, TRANSPARENT_INDEX } from '@caelestis/shared'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ARCHIVE_ADMIN } from '../support/archive.js'
import { bundleWorker, openCloudflare } from '../support/cloudflare.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

let worker = ''
beforeAll(async () => {
  worker = await bundleWorker()
}, 60_000)

const admin = { authorization: `Bearer ${ARCHIVE_ADMIN}` }

describe('Cloudflare Worker alarms', { timeout: 120_000 }, () => {
  it("opens an alarm when a reporter's upload loses a correct pixel", async () => {
    const cloudflare = await openCloudflare(worker)
    cleanups.push(cloudflare.dispose)
    const call = async (path: string, init: RequestInit, status: number) => {
      const response = await cloudflare.fetch(`${cloudflare.api}${path}`, init)
      const text = await response.text()
      expect(response.status, `${path}: ${text}`).toBe(status)
      return text ? (JSON.parse(text) as Record<string, unknown>) : {}
    }
    const form = new FormData()
    form.set('png', new File([await encodeIndexedPng(3, 1, new Uint8Array([1, 1, 1]))], 'art.png'))
    form.set('name', 'Alarmed')
    form.set('season', '0')
    form.set('originX', '10')
    form.set('originY', '20')
    const { templateId } = await call(
      '/admin/templates',
      { method: 'POST', headers: admin, body: form },
      201,
    )
    await call(
      `/admin/templates/${templateId}`,
      {
        method: 'PATCH',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify({ published: true }),
      },
      200,
    )
    const { token } = await call(
      '/admin/tokens',
      {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'reporter', scope: 'report' }),
      },
      201,
    )

    let observedAt = Math.floor(Date.now() / 1_000) - 60
    const observe = async (correct: number) => {
      const indices = new Uint8Array(1_000_000).fill(TRANSPARENT_INDEX)
      indices.fill(1, 20_010, 20_010 + correct)
      const canvas = await encodeIndexedPng(1_000, 1_000, indices)
      await call(
        `/telemetry/tiles/0/0/${await sha256Hex(canvas)}`,
        {
          method: 'PUT',
          body: canvas,
          headers: {
            authorization: `Bearer ${String(token)}`,
            'x-caelestis-season': '0',
            'x-caelestis-observed-at': String(++observedAt),
            'x-caelestis-wplace-user-id': '42',
            'x-caelestis-display-name': 'Mia',
          },
        },
        200,
      )
    }
    const alarm = async () =>
      await cloudflare.database
        .prepare('SELECT peak_correct, alarm_id, pixels_lost FROM template_alarm_states')
        .first<{ peak_correct: number; alarm_id: string | null; pixels_lost: number | null }>()

    // Painting toward a new high-water mark moves the peak but opens nothing.
    await observe(1)
    await observe(2)
    expect(await alarm()).toMatchObject({ peak_correct: 2, alarm_id: null })
    // Losing a correct pixel opens an episode at once.
    await observe(1)
    expect(await alarm()).toMatchObject({ peak_correct: 2, pixels_lost: 1 })
    expect((await alarm())?.alarm_id).not.toBeNull()
  })
})
