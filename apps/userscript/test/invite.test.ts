import { afterEach, expect, it, vi } from 'vitest'
import {
  adminToken,
  backendFetch,
  createTestBackend,
  mintEventRunnerInvite,
  readToken,
  reportToken,
} from './backend.js'
import { importStateModules } from './state-modules.js'

const origin = 'https://invite.test'

const installBackend = async () => {
  const { app } = await createTestBackend()
  const fetch = vi.fn(backendFetch(app, origin))
  vi.stubGlobal('fetch', fetch)
  window.fetch = fetch
  return fetch
}

/** The invite module and the connection state it writes, fresh for each test. */
const load = async () => {
  vi.resetModules()
  const modules = { ...(await import('../src/invite.js')), ...(await importStateModules()) }
  const connected = vi.fn()
  modules.onServerConnected(connected)
  const clearHash = vi.fn()
  const accept = (token: string, url = origin) =>
    modules.consumeInvite(`#${modules.encodeInvite(url, token)}`, clearHash)
  return { ...modules, connected, clearHash, accept }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('connects a new server with the invite token and tells connect listeners', async () => {
  await installBackend()
  const invite = await load()

  const outcome = await invite.accept(readToken)

  expect(outcome).toMatchObject({ kind: 'connected', server: { url: origin, token: readToken } })
  expect(invite.getState().servers).toMatchObject([
    { url: origin, token: readToken, status: 'connected' },
  ])
  expect(invite.connected).toHaveBeenCalledExactlyOnceWith(invite.getState().servers[0])
  expect(invite.clearHash).toHaveBeenCalledOnce()
})

it('trades a one-use event-runner invite for a kept token that runs captures', async () => {
  const fetch = await installBackend()
  const invite = await load()
  const inviteToken = await mintEventRunnerInvite(fetch, origin)

  const outcome = await invite.accept(inviteToken)

  expect(outcome?.kind).toBe('connected')
  const [server] = invite.getState().servers
  expect(server).toMatchObject({ status: 'connected', isAdmin: false, canRunCaptures: true })
  expect(server?.token).toEqual(expect.any(String))
  expect(server?.token).not.toBe(inviteToken)
  expect(server !== undefined && invite.canRunServerCaptures(server)).toBe(true)
  const spent = await fetch(`${origin}/v1/auth/exchange`, {
    method: 'POST',
    headers: { authorization: `Bearer ${inviteToken}` },
  })
  expect(spent.status).toBe(401)
})

it('leaves an event-runner invite unspent when the connection list is full', async () => {
  const fetch = await installBackend()
  const invite = await load()
  const inviteToken = await mintEventRunnerInvite(fetch, origin)
  for (let index = 0; index < invite.MAX_CONNECTED_SERVERS; index++)
    invite.upsertServer({
      url: `https://full-${index}.test`,
      info: null,
      token: null,
      status: 'unreachable',
      isAdmin: false,
      season: null,
    })

  expect((await invite.accept(inviteToken))?.kind).toBe('full')

  await invite.removeServer('https://full-0.test')
  expect((await invite.accept(inviteToken))?.kind).toBe('connected')
})

it('keeps an exchanged invite for a retry when the manifest fails, and the old token until then', async () => {
  const fetch = await installBackend()
  const invite = await load()
  await invite.accept(reportToken)
  const inviteToken = await mintEventRunnerInvite(fetch, origin)
  const answer = fetch.getMockImplementation()
  fetch.mockImplementation(async (input, init) =>
    new URL(String(input)).pathname.endsWith('/manifest')
      ? new Response('unavailable', { status: 503 })
      : await answer!(input, init),
  )

  expect((await invite.accept(inviteToken))?.kind).toBe('unreachable')
  expect(invite.getState().servers).toMatchObject([{ token: reportToken, status: 'connected' }])

  fetch.mockImplementation(answer!)
  expect((await invite.accept(inviteToken))?.kind).toBe('connected')
  const [server] = invite.getState().servers
  expect(server?.token).not.toBe(reportToken)
  expect(server !== undefined && invite.canRunServerCaptures(server)).toBe(true)
})

it.each([
  [reportToken, false],
  [adminToken, true],
])('offers capture control to %s only when its scope reaches event runner', async (token, runs) => {
  await installBackend()
  const invite = await load()

  await invite.accept(token)

  const [server] = invite.getState().servers
  expect(server?.token).toBe(token)
  expect(server !== undefined && invite.canRunServerCaptures(server)).toBe(runs)
})

it('leaves a fragment that is not an invite alone', async () => {
  const fetch = await installBackend()
  const invite = await load()

  expect(await invite.consumeInvite('#foo.bar', invite.clearHash)).toBeNull()
  expect(invite.clearHash).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('clears a malformed invite without probing', async () => {
  const fetch = await installBackend()
  const invite = await load()

  const outcome = await invite.consumeInvite(
    '#aHR0cHM6Ly9ob3N0LmV4YW1wbGU.dG9rZW4.ZXh0cmE',
    invite.clearHash,
  )

  expect(outcome).toEqual({ kind: 'malformed' })
  expect(invite.clearHash).toHaveBeenCalledOnce()
  expect(fetch).not.toHaveBeenCalled()
})

it('clears the hash before the first request', async () => {
  const fetch = await installBackend()
  const invite = await load()
  const requestsWhenCleared: number[] = []
  invite.clearHash.mockImplementation(() => requestsWhenCleared.push(fetch.mock.calls.length))

  await invite.accept(readToken)

  expect(requestsWhenCleared).toEqual([0])
})

it('rotates the token of a stored server', async () => {
  await installBackend()
  const invite = await load()
  await invite.accept(readToken)
  invite.connected.mockClear()

  const outcome = await invite.accept(adminToken)

  expect(outcome?.kind).toBe('connected')
  expect(invite.getState().servers).toMatchObject([{ url: origin, token: adminToken }])
  expect(invite.connected).toHaveBeenCalledOnce()
})

it('keeps the stored credential when the invite token is refused', async () => {
  await installBackend()
  const invite = await load()
  await invite.accept(readToken)
  const servers = invite.getState().servers
  invite.connected.mockClear()

  const outcome = await invite.accept('rejected-invite-token')

  expect(outcome?.kind).toBe('refused')
  expect(invite.getState().servers).toBe(servers)
  expect(invite.connected).not.toHaveBeenCalled()
})

it('does not probe a server already connected with the same token', async () => {
  const fetch = await installBackend()
  const invite = await load()
  await invite.accept(readToken)
  fetch.mockClear()

  const outcome = await invite.accept(readToken)

  expect(outcome?.kind).toBe('already')
  expect(fetch).not.toHaveBeenCalled()
})

it('stores nothing for an unreachable server', async () => {
  const invite = await load()

  const outcome = await invite.accept(readToken)

  expect(outcome).toMatchObject({ kind: 'unreachable', server: { url: origin } })
  expect(invite.getState().servers).toEqual([])
})

it('refuses a server past the connection limit', async () => {
  await installBackend()
  const invite = await load()
  for (let index = 0; index < invite.MAX_CONNECTED_SERVERS; index++)
    invite.upsertServer({
      url: `https://full-${index}.test`,
      info: null,
      token: null,
      status: 'unreachable',
      isAdmin: false,
      season: null,
    })

  const outcome = await invite.accept(readToken)

  expect(outcome?.kind).toBe('full')
  expect(invite.getState().servers.some((server) => server.url === origin)).toBe(false)
})

it('answers a second invite busy while one is in flight, without probing it', async () => {
  const fetch = await installBackend()
  const invite = await load()
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const answer = fetch.getMockImplementation()
  fetch.mockImplementation(async (input, init) => {
    await held
    return await answer!(input, init)
  })

  const first = invite.accept(readToken)
  const second = await invite.accept(readToken, 'https://other.test')
  release()

  expect(second).toEqual({ kind: 'busy', url: 'https://other.test', disconnecting: false })
  expect((await first)?.kind).toBe('connected')
  expect(fetch.mock.calls.every(([input]) => new URL(String(input)).origin === origin)).toBe(true)
})
