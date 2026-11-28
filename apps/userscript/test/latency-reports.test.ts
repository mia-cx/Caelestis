import { afterEach, expect, it, vi } from 'vitest'
import { connectPresence, FakeWebSocket } from './presence-socket.js'

const BACKEND = 'https://backend.wplace.live'

vi.mock('../src/wplace-account.js', () => ({
  accountIdentity: () => ({ wplaceUserId: 42, displayName: 'Mia' }),
  loadAccount: async () => undefined,
}))

const teardown: (() => void)[] = []
afterEach(() => {
  for (const undo of teardown.splice(0).reverse()) undo()
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.resetModules()
  FakeWebSocket.instances = []
})

const reports = (socket: FakeWebSocket) =>
  socket.sent.map((data) => JSON.parse(data)).filter((event) => event.type === 'latency-report')

it("reports this tab's latency to Wplace to an event server, with each Paint click timed", async () => {
  const { socket, dispose } = await connectPresence({
    capture: 1,
    scope: 'report',
    canWrite: true,
  })
  teardown.push(dispose)
  // Wplace's backend answers each request when the test says; everything else is the server's.
  const answers: ((response: Response) => void)[] = []
  const serverFetch = window.fetch
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    URL.parse(input instanceof Request ? input.url : String(input), window.location.href)
      ?.origin === BACKEND
      ? new Promise<Response>((resolve) => answers.push(resolve))
      : serverFetch(input, init)) as typeof fetch
  teardown.push(() => {
    window.fetch = serverFetch
  })
  const { installPageRequestObserver } = await import('../src/page-requests.js')
  const requests = installPageRequestObserver(window)
  teardown.push(() => requests?.restore())
  const timing = await import('../src/capture-timing.js')
  timing.observeWplaceTiming()
  const answer = async (status = 200) => {
    answers.shift()?.(new Response(null, { status }))
    await vi.advanceTimersByTimeAsync(0)
  }
  const roundTrip = async (ms: number) => {
    void window.fetch(`${BACKEND}/me`)
    await vi.advanceTimersByTimeAsync(ms)
    await answer()
  }

  await roundTrip(100)
  // The territory event's Paint panel is open; Wplace sends a paint 30 ms after a Paint click.
  document.body.insertAdjacentHTML(
    'beforeend',
    '<div><button>Cancel</button><button class="btn btn-primary">Paint (0:04)</button></div>',
  )
  let sends = false
  document.querySelector('.btn-primary')?.addEventListener('click', () => {
    if (sends) setTimeout(() => void window.fetch(`${BACKEND}/paint`, { method: 'POST' }), 30)
  })
  // A click Wplace sends nothing for doesn't take the next click's request.
  document.querySelector<HTMLButtonElement>('.btn-primary')?.click()
  await vi.advanceTimersByTimeAsync(500)
  sends = true
  // A capture slot presses Paint the same way, and shares the click's timing.
  const { submitWorldPaintDraft } = await import('../src/wplace-paint.js')
  const slot = timing.timedPress(submitWorldPaintDraft)
  await vi.advanceTimersByTimeAsync(30 + 150)
  await answer(200)
  const painted = { clickToSendMs: 30, sendToResponseMs: 150, status: 200 }
  await expect(slot).resolves.toEqual(painted)
  // The first paint is reported at once; the median is over both round trips.
  await vi.advanceTimersByTimeAsync(0)
  expect(reports(socket)).toEqual([
    { type: 'latency-report', wplaceRttMs: 125, rttSamples: 2, paints: [painted] },
  ])

  // Five minutes with nothing new to say send nothing.
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(reports(socket)).toHaveLength(1)
  // A new round trip goes out at the next report, without those older than five minutes.
  await vi.advanceTimersByTimeAsync(60_000)
  await roundTrip(120)
  await vi.advanceTimersByTimeAsync(4 * 60_000)
  expect(reports(socket).slice(1)).toEqual([
    { type: 'latency-report', wplaceRttMs: 120, rttSamples: 1, paints: [] },
  ])
})
