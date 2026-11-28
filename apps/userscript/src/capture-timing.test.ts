// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const BACKEND = 'https://backend.wplace.live'

const teardown: (() => void)[] = []
afterEach(() => {
  for (const undo of teardown.splice(0).reverse()) undo()
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.resetModules()
})

/**
 * A fresh timing module watching a page whose fetches Wplace's backend answers when the test says:
 * `answer(status)` settles the oldest open request, `fail()` rejects it.
 */
const page = async () => {
  const open: { resolve: (response: Response) => void; reject: (error: Error) => void }[] = []
  window.fetch = vi.fn(
    () => new Promise<Response>((resolve, reject) => open.push({ resolve, reject })),
  ) as typeof fetch
  const { installPageRequestObserver } = await import('./page-requests.js')
  const timing = await import('./capture-timing.js')
  const requests = installPageRequestObserver(window)
  teardown.push(() => requests?.restore())
  timing.observeWplaceTiming()
  const next = () => {
    const request = open.shift()
    if (request === undefined) throw new Error('No open request')
    return request
  }
  return {
    ...timing,
    request: (path: string, init?: RequestInit) =>
      window.fetch(`${BACKEND}${path}`, init).catch(() => undefined),
    answer: async (status = 200) => next().resolve(new Response(null, { status })),
    fail: () => next().reject(new TypeError('network error')),
    wait: (ms: number) => vi.advanceTimersByTimeAsync(ms),
  }
}

const now = () => performance.timeOrigin + performance.now()

it("estimates Wplace's round trip as the median of its requests, leaving out tiles", async () => {
  const wplace = await page()
  expect(wplace.wplaceRtt()).toBeNull()
  for (const ms of [100, 300, 200]) {
    const sent = wplace.request('/me')
    await wplace.wait(ms)
    await wplace.answer()
    await sent
  }
  // Tiles the browser cache answers at once say nothing about the network.
  for (const path of ['/files/s0/tiles/1/2.png', '/files/s0/tiles/1/3.png']) {
    const tile = wplace.request(path)
    await wplace.answer()
    await tile
  }
  expect(wplace.wplaceRtt()).toBe(200)
})

it('times the first paint request after the click, and only that one', async () => {
  const wplace = await page()
  // A paint already in flight at the click is not the click's.
  const earlier = wplace.request('/paint', { method: 'POST' })
  const timed = wplace.timeNextPaint(now())
  await wplace.wait(15)
  await wplace.answer()
  await earlier
  await wplace.wait(25)
  const other = wplace.request('/me')
  const paint = wplace.request('/paint', { method: 'POST' })
  const again = wplace.request('/paint', { method: 'POST' })
  await wplace.answer()
  await wplace.wait(120)
  await wplace.answer(429)
  await wplace.answer(500)
  await Promise.all([other, paint, again])
  await expect(timed).resolves.toEqual({ clickToSendMs: 40, sendToResponseMs: 120, status: 429 })
})

it('records a click that Wplace sent no paint request for, or whose request failed', async () => {
  const wplace = await page()
  const none = wplace.timeNextPaint(now())
  await wplace.wait(10_000)
  await expect(none).resolves.toEqual({
    clickToSendMs: null,
    sendToResponseMs: null,
    status: 'no-request',
  })

  const failed = wplace.timeNextPaint(now())
  await wplace.wait(30)
  const paint = wplace.request('/paint', { method: 'POST' })
  wplace.fail()
  await paint
  await expect(failed).resolves.toEqual({
    clickToSendMs: 30,
    sendToResponseMs: null,
    status: 'failed',
  })
})
