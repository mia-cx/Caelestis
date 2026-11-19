import { encodeIndexedPng, sha256Hex, TRANSPARENT_INDEX } from '@caelestis/shared'
import { expect, it, vi } from 'vitest'
import { authorized, createTestBackend } from './support/backend.js'

/** Turned on, every template chunk claims a rectangle that overruns its own tile. */
const broken = vi.hoisted(() => ({ rect: false }))

vi.mock('@caelestis/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@caelestis/shared')>()
  return {
    ...actual,
    chunkRect: (...args: Parameters<typeof actual.chunkRect>) =>
      broken.rect ? { left: 998, top: 20, width: 3, height: 1 } : actual.chunkRect(...args),
  }
})

const createTemplate = async (
  app: Awaited<ReturnType<typeof createTestBackend>>['app'],
  originX: number,
) => {
  const form = new FormData()
  const artwork = await encodeIndexedPng(4, 1, new Uint8Array([1, 1, 1, TRANSPARENT_INDEX]))
  form.set('png', new File([artwork], 'art.png', { type: 'image/png' }))
  form.set('name', `Template ${originX}`)
  form.set('season', '3')
  form.set('originX', String(originX))
  form.set('originY', '20')
  const response = await app.fetch(authorized('/admin/templates', { method: 'POST', body: form }))
  expect(response.status).toBe(201)
}

const canvas = async (colour: number) => {
  const bytes = await encodeIndexedPng(
    1000,
    1000,
    new Uint8Array(1_000_000).fill(TRANSPARENT_INDEX).fill(colour, 20010, 20014),
  )
  return { bytes, hash: await sha256Hex(bytes) }
}

const observedAt = () => Math.floor(Date.now() / 1_000)

const upload = (
  app: Awaited<ReturnType<typeof createTestBackend>>['app'],
  tile: { bytes: Uint8Array; hash: string },
) =>
  app.fetch(
    authorized(`/telemetry/tiles/0/0/${tile.hash}`, {
      method: 'PUT',
      body: tile.bytes,
      headers: {
        'x-caelestis-season': '3',
        'x-caelestis-observed-at': String(observedAt()),
        'x-caelestis-wplace-user-id': '42',
        'x-caelestis-display-name': 'Painter',
      },
    }),
  )

it('answers a chunk that disagrees with its own rectangle as a server failure on upload and offer', async () => {
  const { app } = await createTestBackend()
  await createTemplate(app, 10)
  const held = await canvas(1)
  expect((await upload(app, held)).status).toBe(200)
  expect((await upload(app, await canvas(2))).status).toBe(200)
  // A second template has never classified the held bytes, so the offer below classifies afresh.
  await createTemplate(app, 100)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  broken.rect = true

  expect((await upload(app, await canvas(3))).status).toBe(500)
  const offer = await app.fetch(
    authorized('/telemetry/tiles/offers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        season: 3,
        wplaceUserId: 42,
        displayName: 'Painter',
        offers: [{ tile: '0/0', sha256: held.hash, ts: observedAt() }],
      }),
    }),
  )
  expect(offer.status).toBe(500)
})

it('still refuses bytes that do not match their hash as the reporter mistake', async () => {
  const { app } = await createTestBackend()
  await createTemplate(app, 10)
  const tile = await canvas(1)
  const response = await upload(app, { bytes: tile.bytes, hash: '0'.repeat(64) })
  expect(response.status).toBe(400)
})
