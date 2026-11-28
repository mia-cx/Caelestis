import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const leaderboard = (me: unknown) => () => Promise.resolve(Response.json({ top: [], me }))

/** Wplace's own leaderboard reads, as the page-request route sees them. */
const pageReads = async () => {
  const routes: Parameters<typeof import('./page-requests.js').observePageRequests>[0][] = []
  vi.spyOn(await import('./page-requests.js'), 'observePageRequests').mockImplementation(
    (route) => {
      routes.push(route)
      return () => {}
    },
  )
  const url = new URL('https://backend.wplace.live/territory/leaderboard')
  return (me: unknown) =>
    routes[0]?.({ url, isGet: () => true } as never)?.response?.(Response.json({ top: [], me }))
}

it("reads the team through the page's fetch, which carries Wplace's session", async () => {
  // The script's own fetch goes out signed out: Wplace answers without a `me`.
  vi.stubGlobal('fetch', vi.fn(leaderboard(null)))
  vi.stubGlobal('unsafeWindow', {
    fetch: vi.fn(leaderboard({ team: 1, pixels: 40 })),
    AbortSignal,
  })
  const { readEventTeam } = await import('./event-team.js')
  expect(await readEventTeam()).toBe(1)
})

it("takes the team from Wplace's own leaderboard reads", async () => {
  const read = await pageReads()
  const { installEventTeam, eventTeam } = await import('./event-team.js')
  installEventTeam()
  read({ team: 2 })
  await vi.waitFor(() => expect(eventTeam()).toBe(2))
})

it('keeps a team Wplace reported while an older lookup was still parsing', async () => {
  let parse = (_body: unknown) => {}
  const body = new Promise((resolve) => {
    parse = resolve
  })
  vi.stubGlobal('unsafeWindow', {
    fetch: () => Promise.resolve({ ok: true, json: () => body }),
    AbortSignal,
  })
  const read = await pageReads()
  const { installEventTeam, eventTeam, readEventTeam } = await import('./event-team.js')
  installEventTeam()
  const lookup = readEventTeam()
  read({ team: 3 })
  await vi.waitFor(() => expect(eventTeam()).toBe(3))
  // The older answer, from before the painter joined, arrives last.
  parse({ top: [], me: null })
  expect(await lookup).toBe(3)
  expect(eventTeam()).toBe(3)
})

/** The page's `WebSocket` as Wplace calls it, delivering the messages a test hands it. */
class FakeSocket extends EventTarget {
  constructor(readonly url: string) {
    super()
  }
  receive(message: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
  }
}

const territorySocket = async () => {
  const page = { WebSocket: FakeSocket, location: { href: 'https://wplace.live/' } }
  vi.stubGlobal('unsafeWindow', page)
  const module = await import('./event-team.js')
  module.installEventTeam()
  return {
    ...module,
    open: () => new page.WebSocket('wss://backend.wplace.live/territory/ws?since=0'),
  }
}

it("reads the team from Wplace's territory socket for a painter the leaderboard leaves out", async () => {
  const { eventTeam, open } = await territorySocket()
  const socket = open()
  expect(socket).toBeInstanceOf(FakeSocket)
  socket.receive({ t: 'hello', authed: true, me: { team: 3, pixels: 0 }, teams: [], seq: 1 })
  expect(eventTeam()).toBe(3)
})

it('learns the team from the reply to a paint, and knows a greeted painter without one has not joined', async () => {
  const { eventTeam, eventTeamUnjoined, open } = await territorySocket()
  const socket = open()
  socket.receive({ t: 'hello', authed: true, me: null, teams: [], seq: 1 })
  expect(eventTeamUnjoined()).toBe(true)
  socket.receive({ t: 'ack', id: 1, result: { painted: 1, refused: 0, seq: 2, me: { team: 1 } } })
  expect(eventTeam()).toBe(1)
  expect(eventTeamUnjoined()).toBe(false)
})

it('finds a top-10 painter in the leaderboard rows when Wplace leaves `me` empty', async () => {
  vi.spyOn(await import('./wplace-account.js'), 'accountIdentity').mockReturnValue({
    wplaceUserId: 7,
    displayName: 'Painter',
  })
  vi.stubGlobal('unsafeWindow', {
    fetch: () =>
      Promise.resolve(
        Response.json({
          top: [
            { id: 5, team: 0 },
            { id: 7, team: 3 },
          ],
          teamTop: [],
          me: null,
        }),
      ),
    AbortSignal,
  })
  const { readEventTeam } = await import('./event-team.js')
  expect(await readEventTeam()).toBe(3)
})

it('answers with a team the socket carried while a leaderboard lookup failed', async () => {
  let fail = () => {}
  const page = {
    WebSocket: FakeSocket,
    location: { href: 'https://wplace.live/' },
    fetch: () =>
      new Promise<Response>((resolve) => {
        fail = () => resolve(new Response(null, { status: 503 }))
      }),
    AbortSignal,
  }
  vi.stubGlobal('unsafeWindow', page)
  const { installEventTeam, readEventTeam } = await import('./event-team.js')
  installEventTeam()
  const lookup = readEventTeam()
  new page.WebSocket('wss://backend.wplace.live/territory/ws').receive({
    t: 'hello',
    authed: true,
    me: { team: 2 },
  })
  fail()
  expect(await lookup).toBe(2)
})
