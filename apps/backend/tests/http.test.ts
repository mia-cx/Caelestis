import { describe, expect, it } from 'vitest'
import { createTestBackend } from './support/backend.js'

describe('HTTP application contracts', () => {
  it('serves health and identical root and v1 server metadata', async () => {
    const { app } = await createTestBackend()

    expect(await (await app.fetch(new Request('https://backend.test/health'))).json()).toEqual({
      ok: true,
    })
    const root = await app.fetch(new Request('https://backend.test/server'))
    const v1 = await app.fetch(new Request('https://backend.test/v1/server'))

    expect(root.status).toBe(200)
    expect(await root.json()).toEqual(await v1.json())
  })

  it('lets only in-process requests read a closed server without a token', async () => {
    const { app } = await createTestBackend()
    const { IN_PROCESS_READ } = await import('../src/auth/middleware.js')
    const inProcess = { [IN_PROCESS_READ]: true }

    expect((await app.fetch(new Request('https://backend.test/manifest'))).status).toBe(401)
    expect((await app.fetch(new Request('https://backend.test/manifest'), inProcess)).status).toBe(
      200,
    )
    expect(
      (
        await app.fetch(
          new Request('https://backend.test/admin/server', { method: 'PATCH', body: '{}' }),
          inProcess,
        )
      ).status,
    ).toBe(401)
  })

  it('rejects a revoked credential and makes a retried partial paint idempotent through the route', async () => {
    const { app, sql } = await createTestBackend()
    const reportToken = 'REPORT-TEST-TOKEN'
    const { hashToken } = await import('../src/auth/tokens.js')
    const { millis } = await import('@caelestis/shared')
    const tokenHash = await hashToken(reportToken)
    await sql.insertAccessToken({
      tokenHash,
      label: 'test reporter',
      scope: 'report',
      createdWithToken: tokenHash,
      createdAt: millis(2),
    })
    const reportHeaders = {
      authorization: `Bearer ${reportToken}`,
      'content-type': 'application/json',
    }
    const event = {
      eventId: '01890f3e-7b2c-7abc-8def-012345678901',
      wplaceUserId: 7,
      displayName: 'Mia',
      season: 3,
      ts: Math.floor(Date.now() / 1_000),
      tiles: [{ x: 0, y: 0, pixels: { x: [0], y: [0], colors: [1] } }],
      painted: null,
    }
    // A paint body is bounded like the live transport's, before it is parsed.
    const { MAX_LIVE_PAINT_BYTES } = await import('@caelestis/shared')
    const oversized = await app.fetch(
      new Request('https://backend.test/telemetry/paints', {
        method: 'POST',
        headers: reportHeaders,
        body: JSON.stringify(event).padEnd(MAX_LIVE_PAINT_BYTES + 1),
      }),
    )
    expect(oversized.status).toBe(400)
    expect(
      await (
        await app.fetch(
          new Request('https://backend.test/telemetry/paints', {
            method: 'POST',
            headers: reportHeaders,
            body: JSON.stringify(event),
          }),
        )
      ).json(),
    ).toMatchObject({ accepted: true, partial: true })
    expect(
      await (
        await app.fetch(
          new Request('https://backend.test/telemetry/paints', {
            method: 'POST',
            headers: reportHeaders,
            body: JSON.stringify(event),
          }),
        )
      ).json(),
    ).toEqual({ accepted: false, duplicate: true })

    expect(
      (
        await app.fetch(
          new Request('https://backend.test/admin/server', {
            method: 'PATCH',
            headers: reportHeaders,
            body: JSON.stringify({ name: 'Forbidden' }),
          }),
        )
      ).status,
    ).toBe(403)

    await sql.revokeAccessToken(tokenHash)
    expect(
      (
        await app.fetch(
          new Request('https://backend.test/telemetry/paints', {
            method: 'POST',
            headers: reportHeaders,
            body: JSON.stringify(event),
          }),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await app.fetch(
          new Request('https://backend.test/admin/server', {
            method: 'PATCH',
            headers: reportHeaders,
            body: JSON.stringify({ name: 'Forbidden' }),
          }),
        )
      ).status,
    ).toBe(401)
  })
})
