import {
  MAX_HOME_COPY_LENGTH,
  millis,
  SERVER_ASSET_MAX_BYTES,
  type ServerAssetKind,
  sha256Hex,
} from '@caelestis/shared'
import { Manifest, ServerInfo } from '@caelestis/wire-schema'
import { Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import { makeBackendContext } from '../runtime/backend-runtime.js'
import { DirectStatusReadModel } from '../status-read-model/port.js'

const token = 'bootstrap-operator-token'
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const gif = new TextEncoder().encode('GIF89a')
const harness = (openAccess = true) => {
  const sql = new MemorySqlStore()
  const blobs = new MemoryBlobStore()
  const readModel = new DirectStatusReadModel(sql)
  const notify = vi.spyOn(readModel, 'notifyManifestChange')
  const app = createApp(
    makeBackendContext(
      blobs,
      sql,
      new MemoryCounterStore(sql, () => millis(Date.now())),
      readModel,
    ),
    { bootstrapAdminToken: token, openAccess },
  )
  const patch = (body: unknown, credential = token) =>
    app.request('/v1/admin/server', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const upload = (kind: string, bytes: Uint8Array = png, headers: Record<string, string> = {}) =>
    app.request(`/v1/admin/server/assets/${kind}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain', ...headers },
      body: bytes.slice().buffer,
    })
  const remove = (kind: string) =>
    app.request(`/v1/admin/server/assets/${kind}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
  const server = async () =>
    Schema.decodeUnknownSync(ServerInfo)(await (await app.request('/v1/server')).json())
  const manifest = async () =>
    Schema.decodeUnknownSync(Manifest)(await (await app.request('/v1/manifest')).json())
  return { app, sql, blobs, notify, patch, upload, remove, server, manifest }
}

describe('public server branding', () => {
  it('publishes every field through server and manifest, and clears optional branding', async () => {
    const { patch, upload, remove, server, manifest, notify } = harness()
    const empty = await server()
    expect(empty).not.toHaveProperty('discordInviteUrl')
    expect(empty).not.toHaveProperty('homeCopy')
    expect(empty).not.toHaveProperty('logoText')
    expect(empty).not.toHaveProperty('logoImage')
    expect(empty).not.toHaveProperty('previewImage')
    const before = await manifest()
    expect(
      (
        await patch({
          name: '  Community  ',
          description: 'Our server',
          discordInviteUrl: ' https://discord.com/invite/Artists ',
          homeCopy:
            '  ## Cafe\u0301\r\n\r\n**Welcome** to [our site](https://example.com).\r\n- Paint  ',
          logoText: '  Cafe\u0301  ',
        })
      ).status,
    ).toBe(200)
    expect((await upload('logo')).status).toBe(200)
    expect((await upload('preview', gif)).status).toBe(200)
    const expected = {
      ...empty,
      name: 'Community',
      description: 'Our server',
      discordInviteUrl: 'https://discord.gg/Artists',
      homeCopy: '## Café\n\n**Welcome** to [our site](https://example.com).\n- Paint',
      logoText: 'Café',
      logoImage: { etag: await sha256Hex(png), contentType: 'image/png' },
      previewImage: { etag: await sha256Hex(gif), contentType: 'image/gif' },
    }
    expect(await server()).toEqual(expected)
    const changed = await manifest()
    expect(changed.server).toEqual(expected)
    expect(changed.version).not.toBe(before.version)
    expect(notify).toHaveBeenCalledTimes(3)
    expect(notify).toHaveBeenLastCalledWith(0, undefined, true)
    expect(
      (await patch({ description: null, discordInviteUrl: null, homeCopy: null, logoText: null }))
        .status,
    ).toBe(200)
    await remove('logo')
    await remove('preview')
    expect(await server()).toEqual({ ...empty, name: 'Community' })
    expect((await manifest()).server).toEqual({ ...empty, name: 'Community' })
    expect(notify).toHaveBeenCalledTimes(6)
  })

  it.each([
    [
      'discordInviteUrl',
      'https://example.com/invite/test',
      'discordInviteUrl must be a Discord invite link, or null',
    ],
    ['discordInviteUrl', 4, 'discordInviteUrl must be a Discord invite link, or null'],
    ['homeCopy', false, 'Home page copy must be text.'],
    [
      'homeCopy',
      'x'.repeat(MAX_HOME_COPY_LENGTH + 1),
      'Home page copy must be at most 4000 characters.',
    ],
    ['homeCopy', 'a\u0000b', 'Home page copy cannot contain control characters.'],
    [
      'homeCopy',
      '[bad](javascript:alert)',
      'Links must start with http:// or https://: javascript:alert',
    ],
    [
      'homeCopy',
      '[link](https://example.com) '.repeat(21),
      'Use at most 20 links in the home page copy.',
    ],
    ['logoText', '', 'logoText must be 1..64 characters, or null'],
    ['logoText', 'x'.repeat(65), 'logoText must be 1..64 characters, or null'],
    ['logoText', 'a\u0000b', 'logoText must be 1..64 characters, or null'],
    ['logoText', {}, 'logoText must be 1..64 characters, or null'],
  ])('rejects invalid %s without applying other fields', async (field, value, error) => {
    const { patch, server, notify } = harness()
    const before = await server()
    const response = await patch({ name: 'Should not persist', [field]: value })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error })
    expect(await server()).toEqual(before)
    expect(notify).not.toHaveBeenCalled()
  })

  it('rejects empty patches and bodies; blank home copy clears without changing other fields', async () => {
    const { patch, sql } = harness()
    for (const body of [{}, { ignored: true }, null, [], 'text']) {
      expect((await patch(body)).status).toBe(400)
    }
    await patch({ homeCopy: 'Hello', logoText: 'A'.repeat(64) })
    expect((await patch({ homeCopy: ' \r\n\t ' })).status).toBe(200)
    expect(await sql.readServerSettings()).toMatchObject({
      homeCopy: null,
      logoText: 'A'.repeat(64),
    })
  })

  it('requires admin scope on all mutations', async () => {
    const { app, blobs, notify } = harness()
    const minted = await app.request('/v1/admin/tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'reader', scope: 'read' }),
    })
    const reader = ((await minted.json()) as { token: string }).token
    for (const [path, method, body] of [
      ['/v1/admin/server', 'PATCH', JSON.stringify({ logoText: 'No' })],
      ['/v1/admin/server/assets/logo', 'PUT', png.slice().buffer],
      ['/v1/admin/server/assets/logo', 'DELETE', undefined],
    ] as const) {
      for (const credential of [null, reader]) {
        expect(
          (
            await app.request(path, {
              method,
              headers: credential === null ? {} : { authorization: `Bearer ${credential}` },
              ...(body === undefined ? {} : { body }),
            })
          ).status,
        ).toBe(credential === null ? 401 : 403)
      }
    }
    expect((await blobs.list('branding', { limit: 10 })).keys).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })

  it.each(['logo', 'preview'] as const)(
    'sniffs, deduplicates, replaces, and deletes %s',
    async (kind) => {
      const { upload, remove, sql, blobs, notify } = harness()
      const etag = await sha256Hex(png)
      const response = await upload(kind)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ etag, contentType: 'image/png' })
      expect((await sql.readServerSettings())[kind]).toEqual({
        blobKey: `${kind}/${etag}`,
        contentType: 'image/png',
      })
      expect(await blobs.get('branding', `${kind}/${etag}`)).toEqual(png)
      const deletion = vi.spyOn(blobs, 'delete')
      await upload(kind)
      expect((await blobs.list('branding', { limit: 10 })).keys).toEqual([`${kind}/${etag}`])
      expect(deletion).not.toHaveBeenCalled()
      await upload(kind, gif)
      expect(await blobs.get('branding', `${kind}/${etag}`)).toBeNull()
      const replacement = `${kind}/${await sha256Hex(gif)}`
      expect(await blobs.get('branding', replacement)).toEqual(gif)
      expect((await remove(kind)).status).toBe(200)
      expect((await sql.readServerSettings())[kind]).toBeNull()
      expect(await blobs.get('branding', replacement)).toBeNull()
      expect(await (await remove(kind)).json()).toEqual({ ok: true })
      expect(notify).toHaveBeenCalledTimes(5)
    },
  )

  it.each(['logo', 'preview'] as const)(
    'enforces %s limits on both the header and actual body',
    async (kind) => {
      const { upload, blobs } = harness()
      const bytes = new Uint8Array(SERVER_ASSET_MAX_BYTES[kind] + 1)
      bytes.set(png)
      const error =
        kind === 'logo' ? 'logo must be at most 512 KiB' : 'preview must be at most 2 MiB'
      for (const response of [
        await upload(kind, png, { 'content-length': String(bytes.length) }),
        await upload(kind, bytes),
        await upload(kind, bytes, { 'content-length': '8' }),
      ]) {
        expect(response.status).toBe(413)
        expect(await response.json()).toEqual({ error })
      }
      expect((await blobs.list('branding', { limit: 10 })).keys).toEqual([])
      expect((await upload(kind, bytes.slice(0, -1))).status).toBe(200)
    },
  )

  it('rejects empty bodies, unsupported containers, and unknown kinds', async () => {
    const { app, upload, remove } = harness()
    expect((await upload('logo', new Uint8Array())).status).toBe(400)
    const response = await upload('logo', new TextEncoder().encode('<svg/>'), {
      'content-type': 'image/png',
    })
    expect(response.status).toBe(415)
    expect(await response.json()).toEqual({ error: 'upload a PNG, JPEG, WebP or GIF image' })
    expect((await upload('other')).status).toBe(404)
    expect((await remove('other')).status).toBe(404)
    expect((await app.request('/v1/server/assets/other')).status).toBe(404)
  })

  it.each(['logo', 'preview'] as const)(
    'serves public %s bytes with validators and versioned caching',
    async (kind: ServerAssetKind) => {
      const { app, upload } = harness(false)
      const path = `/v1/server/assets/${kind}`
      expect((await app.request(path)).status).toBe(404)
      await upload(kind)
      const etag = await sha256Hex(png)
      for (const method of ['GET', 'HEAD']) {
        for (const version of ['', '?v=old', `?v=${etag}`]) {
          const response = await app.request(path + version, { method })
          expect(response.status).toBe(200)
          expect(Object.fromEntries(response.headers)).toMatchObject({
            'content-type': 'image/png',
            'content-length': String(png.length),
            etag: `"${etag}"`,
            'x-content-type-options': 'nosniff',
            'content-disposition': 'inline',
            'cache-control':
              version === `?v=${etag}` ? 'public, max-age=31536000, immutable' : 'public, no-cache',
          })
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(
            method === 'HEAD' ? new Uint8Array() : png,
          )
        }
        for (const validator of [`"${etag}"`, `"other", W/"${etag}"`, '*']) {
          const response = await app.request(`${path}?v=${etag}`, {
            method,
            headers: { 'if-none-match': validator },
          })
          expect(response.status).toBe(304)
          expect(await response.text()).toBe('')
          expect(response.headers.get('etag')).toBe(`"${etag}"`)
          expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
        }
      }
      expect((await app.request(path, { headers: { 'if-none-match': '"other"' } })).status).toBe(
        200,
      )
    },
  )

  it('keeps the previous asset when storing a replacement fails', async () => {
    const { upload, sql, blobs } = harness()
    await upload('logo')
    const previous = await sql.readServerSettings()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vi.spyOn(blobs, 'put').mockRejectedValueOnce(new Error('blob unavailable'))
      expect((await upload('logo', gif)).status).toBe(500)
      vi.spyOn(sql, 'writeServerSettings').mockRejectedValueOnce(new Error('sql unavailable'))
      expect((await upload('logo', gif)).status).toBe(500)
      expect(await sql.readServerSettings()).toEqual(previous)
      expect(await blobs.get('branding', `logo/${await sha256Hex(png)}`)).toEqual(png)
      // The replacement that never became current is gone too: branding is never swept.
      expect(await blobs.get('branding', `logo/${await sha256Hex(gif)}`)).toBeNull()
      expect(errorLog).toHaveBeenCalledTimes(2)
    } finally {
      errorLog.mockRestore()
    }
  })

  it('keeps an object that an overlapping upload restored before the cleanup ran', async () => {
    const { upload, sql, blobs } = harness()
    await upload('logo')
    const previous = await sql.readServerSettings()
    const write = sql.writeServerSettings.bind(sql)
    // Between this request's write and its cleanup, another admin re-uploads the original bytes.
    vi.spyOn(sql, 'writeServerSettings').mockImplementationOnce(async (patch) => {
      await write(patch)
      await write({ logo: previous.logo })
    })
    expect((await upload('logo', gif)).status).toBe(200)
    expect((await sql.readServerSettings()).logo).toEqual(previous.logo)
    expect(await blobs.get('branding', `logo/${await sha256Hex(png)}`)).toEqual(png)
  })
})
