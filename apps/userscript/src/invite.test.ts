import { describe, expect, it } from 'vitest'

import { consumeInvite, encodeInvite, type InviteDeps, readInvite } from './invite.js'
import { type ConnectedServer, MAX_CONNECTED_SERVERS } from './state.js'

const base64url = (bytes: number[]): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

const server = (overrides: Partial<ConnectedServer> = {}): ConnectedServer => ({
  url: 'https://caelestis.example',
  info: { id: '018f1b8c-7f4e-7a8c-8a01-123456789abc', name: 'Example', auth: 'access_token' },
  token: 'example-token',
  status: 'connected',
  isAdmin: false,
  season: 1,
  ...overrides,
})

interface FakeDeps {
  readonly deps: InviteDeps
  readonly cleared: string[]
  readonly probes: Array<{ url: string; token: string }>
  readonly upserts: ConnectedServer[]
  readonly connects: Array<{ server: ConnectedServer; replacing: boolean }>
  readonly notices: Array<{ message: string; tone: string }>
}

const fakeDeps = (
  options: {
    readonly hash?: string
    readonly servers?: ConnectedServer[]
    readonly probe?: (url: string, token: string) => Promise<ConnectedServer>
    readonly upsert?: (server: ConnectedServer) => boolean
    readonly busy?: (url: string) => boolean
  } = {},
): FakeDeps => {
  const cleared: string[] = []
  const probes: Array<{ url: string; token: string }> = []
  const upserts: ConnectedServer[] = []
  const connects: Array<{ server: ConnectedServer; replacing: boolean }> = []
  const notices: Array<{ message: string; tone: string }> = []
  const deps: InviteDeps = {
    hash: options.hash ?? '#',
    clearHash: () => cleared.push('cleared'),
    servers: () => options.servers ?? [],
    probe: async (url, token) => {
      probes.push({ url, token })
      return (await options.probe?.(url, token)) ?? server({ url })
    },
    upsert: (candidate) => {
      upserts.push(candidate)
      return options.upsert?.(candidate) ?? true
    },
    connected: (candidate, replacing) => connects.push({ server: candidate, replacing }),
    notify: (message, tone) => notices.push({ message, tone }),
    isBusy: options.busy ?? (() => false),
  }
  return { deps, cleared, probes, upserts, connects, notices }
}

describe('readInvite', () => {
  it('round-trips http and https invites through encodeInvite', () => {
    for (const url of ['http://localhost:8787', 'https://caelestis.example/backend']) {
      const fragment = encodeInvite(url, 't0k.en_with-punct')
      expect(readInvite(`#${fragment}`)).toEqual({
        serverUrl: url,
        token: 't0k.en_with-punct',
      })
    }
  })

  it('produces the exact documented example link', () => {
    expect(encodeInvite('https://caelestis.example', 'example-token')).toBe(
      'aHR0cHM6Ly9jYWVsZXN0aXMuZXhhbXBsZQ.ZXhhbXBsZS10b2tlbg',
    )
  })

  it.each(['', '#', '#foo', '#foo.bar', '#W5hbWU', '#amF2YXNjcmlwdDphbGVydCgxKQ.x'])(
    'ignores the unrelated fragment %s',
    (hash) => {
      expect(readInvite(hash)).toBeNull()
    },
  )

  it.each([
    ['bad UTF-8 in the server part', `#aHR0c-A.${base64url([116, 111, 107, 101, 110])}`],
    [
      'a credentialed server URL',
      `#${base64url([...new TextEncoder().encode('https://u:p@host.example')])}.dG9rZW4`,
    ],
    ['an empty token', `#${encodeInvite('https://caelestis.example', 'token').split('.')[0]}.`],
    [
      'a whitespace token',
      `#${encodeInvite('https://caelestis.example', 'token').split('.')[0]}.${base64url([...new TextEncoder().encode('bad token')])}`,
    ],
    ['an extra separator', `#${encodeInvite('https://caelestis.example', 'token')}.ZXh0cmE`],
  ])('reports a malformed invite for %s', (_name, hash) => {
    expect(readInvite(hash)).toBe('malformed')
  })
})

describe('consumeInvite', () => {
  const invite = encodeInvite('https://caelestis.example', 'example-token')

  it('connects a new server and reports success', async () => {
    const fake = fakeDeps({ hash: `#${invite}` })
    await consumeInvite(fake.deps)
    expect(fake.cleared).toHaveLength(1)
    expect(fake.probes).toEqual([{ url: 'https://caelestis.example', token: 'example-token' }])
    expect(fake.upserts).toHaveLength(1)
    expect(fake.connects).toEqual([{ server: fake.upserts[0], replacing: false }])
    expect(fake.notices).toEqual([{ message: 'Connected to Example.', tone: 'info' }])
  })

  it.each(['#', '#foo', '#foo.bar'])('leaves the unrelated fragment %s alone', async (hash) => {
    const fake = fakeDeps({ hash })
    await consumeInvite(fake.deps)
    expect(fake.cleared).toHaveLength(0)
    expect(fake.probes).toHaveLength(0)
    expect(fake.notices).toHaveLength(0)
  })

  it('clears a malformed invite and reports it without probing', async () => {
    const fake = fakeDeps({ hash: '#aHR0cHM6Ly9ob3N0LmV4YW1wbGU.dG9rZW4.ZXh0cmE' })
    await consumeInvite(fake.deps)
    expect(fake.cleared).toHaveLength(1)
    expect(fake.probes).toHaveLength(0)
    expect(fake.notices).toEqual([{ message: "That invite link isn't valid.", tone: 'error' }])
  })

  it('does not add an unreachable server', async () => {
    const fake = fakeDeps({
      hash: `#${invite}`,
      probe: async (url, token) => server({ url, token, status: 'unreachable', info: null }),
    })
    await consumeInvite(fake.deps)
    expect(fake.upserts).toHaveLength(0)
    expect(fake.notices).toEqual([
      { message: 'Could not reach https://caelestis.example.', tone: 'error' },
    ])
  })

  it('does not add a server that rejects the invite token', async () => {
    const fake = fakeDeps({
      hash: `#${invite}`,
      probe: async (url, token) => server({ url, token, status: 'needs-token' }),
    })
    await consumeInvite(fake.deps)
    expect(fake.upserts).toHaveLength(0)
    expect(fake.notices).toEqual([
      {
        message: "https://caelestis.example didn't accept the invite's token.",
        tone: 'error',
      },
    ])
  })

  it('reports the connection limit when upsert refuses', async () => {
    const fake = fakeDeps({ hash: `#${invite}`, upsert: () => false })
    await consumeInvite(fake.deps)
    expect(fake.connects).toHaveLength(0)
    expect(fake.notices).toEqual([
      {
        message: `Already connected to ${MAX_CONNECTED_SERVERS} servers. Disconnect one first.`,
        tone: 'error',
      },
    ])
  })

  it('does not probe when the same server and token are already connected', async () => {
    const existing = server()
    const fake = fakeDeps({ hash: `#${invite}`, servers: [existing] })
    await consumeInvite(fake.deps)
    expect(fake.cleared).toHaveLength(1)
    expect(fake.probes).toHaveLength(0)
    expect(fake.upserts).toHaveLength(0)
    expect(fake.notices).toEqual([{ message: 'Already connected to Example.', tone: 'info' }])
  })

  it('rotates the token of an existing server when the invite token works', async () => {
    const existing = server({ token: 'old-token' })
    const fake = fakeDeps({ hash: `#${invite}`, servers: [existing] })
    await consumeInvite(fake.deps)
    expect(fake.probes).toEqual([{ url: 'https://caelestis.example', token: 'example-token' }])
    expect(fake.upserts[0]?.token).toBe('example-token')
    expect(fake.connects).toEqual([{ server: fake.upserts[0], replacing: true }])
  })

  it('keeps existing credentials when a rotated invite token is rejected', async () => {
    const existing = server({ token: 'old-token' })
    const fake = fakeDeps({
      hash: `#${invite}`,
      servers: [existing],
      probe: async (url, token) => server({ url, token, status: 'needs-token' }),
    })
    await consumeInvite(fake.deps)
    expect(fake.upserts).toHaveLength(0)
    expect(fake.notices[0]?.message).toContain("didn't accept the invite's token")
  })

  it('clears the hash before probing', async () => {
    const order: string[] = []
    const fake = fakeDeps({
      hash: `#${invite}`,
      probe: async (url, token) => {
        order.push(`probe:${fake.cleared.length}`)
        return server({ url, token })
      },
    })
    await consumeInvite(fake.deps)
    expect(order).toEqual(['probe:1'])
  })

  it('ignores a second invite while one is in flight', async () => {
    const other = encodeInvite('https://other.example', 'other-token')
    let release!: () => void
    const blocker = new Promise<void>((resolve) => (release = resolve))
    const fake = fakeDeps({
      hash: `#${invite}`,
      probe: async (url, token) => {
        await blocker
        return server({ url, token })
      },
    })
    const first = consumeInvite(fake.deps)
    const second = fakeDeps({ hash: `#${other}` })
    await consumeInvite(second.deps)
    expect(second.probes).toHaveLength(0)
    release()
    await first
  })

  it('never puts the token into a notification', async () => {
    const cases: Array<Parameters<typeof fakeDeps>[0]> = [
      { hash: `#${invite}` },
      {
        hash: `#${invite}`,
        probe: async (url, token) => server({ url, token, status: 'unreachable' }),
      },
      {
        hash: `#${invite}`,
        probe: async (url, token) => server({ url, token, status: 'needs-token' }),
      },
      { hash: `#${invite}`, servers: [server()], upsert: () => false },
      { hash: '#aHR0cHM6Ly9ob3N0LmV4YW1wbGU.dG9rZW4.ZXh0cmE' },
    ]
    for (const options of cases) {
      const fake = fakeDeps(options)
      await consumeInvite(fake.deps)
      for (const { message } of fake.notices) {
        expect(message).not.toContain('example-token')
        expect(message).not.toContain(invite)
      }
    }
  })
})
