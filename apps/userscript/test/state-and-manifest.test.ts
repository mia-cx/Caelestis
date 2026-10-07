import { afterEach, describe, expect, it, vi } from 'vitest'

const serverId = '018f1b8c-7f4e-7a8c-8a01-123456789abc'

const loadState = async () => {
  vi.resetModules()
  return await import('../src/state.js')
}

afterEach(() => vi.restoreAllMocks())

describe('saved server state', () => {
  it('keeps one canonical server and never sends a rejected saved token', async () => {
    localStorage.setItem(
      'caelestis.state.v2',
      JSON.stringify({
        servers: [
          { url: 'https://example.test/', token: 'saved', info: null },
          { url: 'https://example.test', token: 'other', info: null },
          { url: 4 },
        ],
        hiddenColours: [-1, 0, 0, 999],
      }),
    )
    const state = await loadState()
    const loaded = state.loadState()
    expect(loaded.servers).toHaveLength(1)
    expect(loaded.hiddenColours).toEqual([0])
    state.upsertServer({
      ...loaded.servers[0]!,
      status: 'connected',
      token: null,
      tokenUsable: false,
      isAdmin: false,
      season: 1,
    })
    expect(state.activeServerToken(state.getState().servers[0]!)).toBeNull()
    expect(JSON.parse(localStorage.getItem('caelestis.state.v2')!).servers[0].token).toBe('saved')
  })

  it('aborts work belonging to a replaced connection', async () => {
    const state = await loadState()
    const first = {
      url: 'https://example.test',
      info: { id: serverId, name: 'Example', auth: 'none' as const },
      token: 'old',
      status: 'connected' as const,
      isAdmin: true,
      season: 1,
    }
    state.upsertServer(first)
    const signal = state.serverConnectionSignal(state.getState().servers[0]!)
    state.upsertServer({ ...first, token: 'new' })
    expect(signal.aborted).toBe(true)
  })
})

describe('server manifest admission', () => {
  it.each(['newer live manifest', 'replaced connection'] as const)(
    'does not adopt release metadata from a poll superseded by a %s',
    async (replacement) => {
      const state = await loadState()
      const server = {
        url: 'https://example.test',
        info: { id: serverId, name: 'Example', auth: 'none' as const, version: '0.8.0' },
        token: null,
        status: 'connected' as const,
        isAdmin: false,
        season: 1,
      }
      state.upsertServer(server)
      const manifest = (version: string) => ({
        version: 'manifest-revision',
        season: 1,
        server: { ...server.info, version },
        nodes: [],
        templates: [],
        tiles: [],
      })
      let respond: ((response: Response) => void) | undefined
      const response = new Promise<Response>((resolve) => {
        respond = resolve
      })
      const fetch = vi.fn(() => response)
      vi.stubGlobal('fetch', fetch)
      window.fetch = fetch
      const pending = state.listServerContents(server)
      expect(fetch).toHaveBeenCalledOnce()
      if (replacement === 'newer live manifest') {
        expect(state.applyLiveServerManifest(server, manifest('0.9.0'))).not.toBeNull()
      } else {
        state.removeServer(server.url)
        state.upsertServer({ ...server, info: { ...server.info, version: '0.9.0' } })
        expect(state.applyLiveServerManifest(server, manifest('0.8.1'))).toBeNull()
      }
      if (respond === undefined) throw new Error('poll response was not initialized')
      respond(Response.json(manifest('0.8.1')))
      await pending
      expect(state.getState().servers[0]?.info?.version).toBe('0.9.0')
    },
  )

  it('rejects duplicate tree paths and accepts valid server identity', async () => {
    const { parseServerInfo, parseTreeNodes } = await import('../src/server-manifest.js')
    expect(parseServerInfo({ id: serverId, name: 'Example', auth: 'none' })).toMatchObject({
      id: serverId,
    })
    expect(
      parseTreeNodes([
        { id: serverId, parentId: null, path: '/Work', name: 'Work', createdAt: 1_700_000_000_000 },
        {
          id: '018f1b8c-7f4e-7a8c-8a01-123456789abd',
          parentId: null,
          path: '/work',
          name: 'work',
          createdAt: 1_700_000_000_000,
        },
      ]),
    ).toBeNull()
  })

  it('keeps bounded server version metadata and drops unusable values', async () => {
    const { parseServerInfo } = await import('../src/server-manifest.js')
    const base = { id: serverId, name: 'Example', auth: 'none' }
    expect(parseServerInfo({ ...base, version: '0.9.0', build: 'a1b2c3d4e5f6' })).toMatchObject({
      version: '0.9.0',
      build: 'a1b2c3d4e5f6',
    })
    for (const value of ['', 'x'.repeat(65), 9, null]) {
      expect(parseServerInfo({ ...base, version: value, build: value })).toMatchObject(base)
    }
  })

  it.each([
    ['0.8.9', true],
    ['0.9.0', false],
    ['0.9.1', false],
    [undefined, false],
    ['development', false],
    ['0.9', false],
  ] as const)(
    'flags a server version %s against expectation 0.9.0 only when strictly lower',
    async (advertised, expected) => {
      const { backendVersionOutdated } = await import('../src/userscript-update.js')
      expect(backendVersionOutdated(advertised, '0.9.0')).toBe(expected)
    },
  )
})
