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
  // A click Wplace sent nothing for in the ten seconds it waits doesn't take the next click's
  // request.
  document.querySelector<HTMLButtonElement>('.btn-primary')?.click()
  await vi.advanceTimersByTimeAsync(10_500)
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

it("times an arena Paint click by its paint on Wplace's territory socket and the server's reply", async () => {
  const { socket, dispose } = await connectPresence({ capture: 1, scope: 'report', canWrite: true })
  teardown.push(dispose)
  const page = window as unknown as { WebSocket: typeof WebSocket }
  const nativeSocket = page.WebSocket
  teardown.push(() => {
    page.WebSocket = nativeSocket
  })
  const timing = await import('../src/capture-timing.js')
  timing.observeWplaceTiming()
  // Wplace's territory store opens its socket, and sends a paint frame 30 ms after Paint.
  const territory = new page.WebSocket(
    'wss://backend.wplace.live/territory/ws?since=0',
  ) as unknown as FakeWebSocket
  territory.readyState = FakeWebSocket.OPEN
  let id = 0
  document.body.insertAdjacentHTML(
    'beforeend',
    '<div><button>Cancel</button><button class="btn btn-primary">Paint (0:04)</button></div>',
  )
  document.querySelector('.btn-primary')?.addEventListener('click', () => {
    setTimeout(() => territory.send(JSON.stringify({ t: 'paint', pixels: [[1, 2]], id: ++id })), 30)
  })
  const ack = (result: unknown) =>
    territory.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify({ t: 'ack', id, result }) }),
    )
  const { submitWorldPaintDraft } = await import('../src/wplace-paint.js')

  const slot = timing.timedPress(submitWorldPaintDraft)
  await vi.advanceTimersByTimeAsync(30 + 150)
  ack({ painted: 1, refused: 0, seq: 9 })
  const painted = { clickToSendMs: 30, sendToResponseMs: 150, status: 200 }
  await expect(slot).resolves.toEqual(painted)
  // Wplace's frame went out as it sent it.
  expect(territory.sent).toEqual([JSON.stringify({ t: 'paint', pixels: [[1, 2]], id: 1 })])

  // A refusal arrives as a successful reply; it is still a refusal.
  const refusedSlot = timing.timedPress(submitWorldPaintDraft)
  await vi.advanceTimersByTimeAsync(30 + 90)
  ack({ painted: 0, refused: 1, reason: 'not-adjacent', seq: 9 })
  const refused = { clickToSendMs: 30, sendToResponseMs: 90, status: 403 }
  await expect(refusedSlot).resolves.toEqual(refused)

  await vi.advanceTimersByTimeAsync(0)
  expect(reports(socket)).toEqual([
    { type: 'latency-report', wplaceRttMs: 150, rttSamples: 1, paints: [painted] },
  ])
})

it("settles a paint on its own socket's reply when the socket it replaced closes late", async () => {
  const { dispose } = await connectPresence({ capture: 1, scope: 'report', canWrite: true })
  teardown.push(dispose)
  const page = window as unknown as { WebSocket: typeof WebSocket }
  const nativeSocket = page.WebSocket
  teardown.push(() => {
    page.WebSocket = nativeSocket
  })
  const timing = await import('../src/capture-timing.js')
  timing.observeWplaceTiming()
  const open = () =>
    new page.WebSocket('wss://backend.wplace.live/territory/ws') as unknown as FakeWebSocket
  const old = open()
  const territory = open()
  territory.readyState = FakeWebSocket.OPEN
  document.body.insertAdjacentHTML(
    'beforeend',
    '<div><button>Cancel</button><button class="btn btn-primary">Paint (0:04)</button></div>',
  )
  document.querySelector('.btn-primary')?.addEventListener('click', () => {
    territory.send(JSON.stringify({ t: 'paint', pixels: [[1, 2]], id: 1 }))
  })
  const { submitWorldPaintDraft } = await import('../src/wplace-paint.js')

  const slot = timing.timedPress(submitWorldPaintDraft)
  old.dispatchEvent(new Event('close'))
  await vi.advanceTimersByTimeAsync(120)
  territory.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ t: 'ack', id: 1, result: { painted: 1, refused: 0 } }),
    }),
  )
  await expect(slot).resolves.toMatchObject({ sendToResponseMs: 120, status: 200 })
})

it('sends nothing once the round trips it held went stale while no session could hear them', async () => {
  const { socket, dispose } = await connectPresence({ capture: 1, scope: 'report', canWrite: true })
  teardown.push(dispose)
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
  void window.fetch(`${BACKEND}/me`)
  await vi.advanceTimersByTimeAsync(100)
  answers.shift()?.(new Response(null, { status: 200 }))
  // The session drops before the first report, and is back only once that round trip is stale.
  socket.close()
  await vi.advanceTimersByTimeAsync(11 * 60_000)
  const back = FakeWebSocket.instances.at(-1)
  if (back === undefined || back === socket) throw new Error('Expected a reconnect')
  back.open(true)
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect([...reports(socket), ...reports(back)]).toEqual([])
})
