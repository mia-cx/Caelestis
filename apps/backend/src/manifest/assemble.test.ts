import { expect, it } from 'vitest'
import { LIVE_CAPABILITIES } from '../live/session.js'
import { openMemoryDatabase } from '../node/memory-stores.js'
import { assembleManifest } from './assemble.js'

it('carries every live capability in a fixed order, whatever order the caller gives', async () => {
  const { sql, close } = openMemoryDatabase()
  const identity = { id: '01890f3e-7b2c-7abc-8def-0000000000aa', name: 'Caelestis' }
  const assemble = (server: Parameters<typeof assembleManifest>[1]['server']) =>
    assembleManifest(sql, { server, season: 0, includeUnpublished: false })
  try {
    const forward = await assemble({ ...identity, auth: 'access_token', ...LIVE_CAPABILITIES })
    const reversed = await assemble({
      ...Object.fromEntries(Object.entries(LIVE_CAPABILITIES).reverse()),
      auth: 'access_token',
      ...identity,
    })
    expect(Object.keys(forward.server)).toEqual([
      'id',
      'name',
      'auth',
      ...Object.keys(LIVE_CAPABILITIES),
    ])
    expect(reversed.version).toBe(forward.version)
  } finally {
    await close()
  }
})
