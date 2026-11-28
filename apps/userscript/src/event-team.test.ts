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
