import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const leaderboard = (me: unknown) => () => Promise.resolve(Response.json({ top: [], me }))

it("reads the team through the page's fetch, which carries Wplace's session", async () => {
  // The script's own fetch goes out signed out: Wplace answers without a `me`.
  vi.stubGlobal('fetch', vi.fn(leaderboard(null)))
  vi.stubGlobal('unsafeWindow', { fetch: vi.fn(leaderboard({ team: 1, pixels: 40 })) })
  const { readEventTeam } = await import('./event-team.js')
  expect(await readEventTeam()).toBe(1)
})

it("takes the team from Wplace's own leaderboard reads", async () => {
  const { installEventTeam, eventTeam } = await import('./event-team.js')
  const { observePageRequests } = await import('./page-requests.js')
  const routes: Parameters<typeof observePageRequests>[0][] = []
  vi.spyOn(await import('./page-requests.js'), 'observePageRequests').mockImplementation(
    (route) => {
      routes.push(route)
      return () => {}
    },
  )
  installEventTeam()
  const [route] = routes
  const url = new URL('https://backend.wplace.live/territory/leaderboard')
  const watched = route?.({ url, isGet: () => true } as never)
  watched?.response?.(Response.json({ top: [], me: { team: 2 } }))
  await vi.waitFor(() => expect(eventTeam()).toBe(2))
  expect(observePageRequests).toBeDefined()
})
