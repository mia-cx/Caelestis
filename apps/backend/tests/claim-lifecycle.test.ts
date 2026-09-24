import { millis } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { hashToken } from '../src/auth/tokens.js'
import { createTestBackend } from './support/backend.js'
import { openRelationalStore } from './support/relational.js'

it('allows same-painter deletion after credential replacement while fencing edits and stale recreation', async () => {
  const opened = await openRelationalStore()
  try {
    const { app, sql } = await createTestBackend({ sql: opened.sql })
    for (const token of ['old-token', 'new-token']) {
      const tokenHash = await hashToken(token)
      await sql.insertAccessToken({
        tokenHash,
        label: token,
        scope: 'report',
        createdWithToken: tokenHash,
        createdAt: millis(1),
      })
    }
    const actor = { wplaceUserId: 42, displayName: 'Painter' }
    const document = {
      items: [{ id: 'shape', op: 'add', shape: { kind: 'rectangle', x: 10, y: 20, w: 2, h: 3 } }],
    }
    const path = '/work/regions/01890f3e-7b2c-7abc-8def-012345678901?season=3&surface=world'
    const request = (token: string, method: string, body: unknown) =>
      app.fetch(
        new Request(`https://backend.test${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    const claim = { actor, label: 'Original', document }
    expect((await request('old-token', 'PUT', claim)).status).toBe(200)
    expect((await request('new-token', 'PUT', { ...claim, label: 'Stolen edit' })).status).toBe(403)
    expect((await request('new-token', 'DELETE', { actor, withdraw: true })).status).toBe(403)
    expect(
      (
        await request('new-token', 'DELETE', {
          actor: { ...actor, wplaceUserId: 7 },
          withdraw: false,
        })
      ).status,
    ).toBe(403)
    expect((await request('new-token', 'DELETE', { actor, withdraw: false })).status).toBe(200)
    expect((await request('old-token', 'PUT', claim)).status).toBe(410)
    const listed = await app.fetch(
      new Request('https://backend.test/work/regions?season=3&surface=world', {
        headers: { authorization: 'Bearer new-token' },
      }),
    )
    expect(await listed.json()).toEqual({ regions: [] })
  } finally {
    await opened.close()
  }
})
