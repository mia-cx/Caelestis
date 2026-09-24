import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workersDevFetch } from './workers-dev-fetch.mjs'

const missingRoute = () =>
  new Response(
    '<title>Page not found</title><link href="https://workers.cloudflare.com/favicon.ico">',
    { status: 404, headers: { 'content-type': 'text/html' } },
  )

test('replays a buffered request only when workers.dev has not routed it to the Worker', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args)
    return calls.length === 1 ? missingRoute() : new Response('created', { status: 201 })
  })
  const request = { method: 'POST', body: JSON.stringify({ name: 'reporter' }) }
  const response = await workersDevFetch('https://test.workers.dev/admin/tokens', request)
  assert.equal(response.status, 201)
  assert.deepEqual(calls, [
    ['https://test.workers.dev/admin/tokens', request],
    ['https://test.workers.dev/admin/tokens', request],
  ])
})

test('returns application errors unchanged without retrying', async (t) => {
  for (const response of [
    new Response('{"error":"not found"}', { status: 404 }),
    new Response('<title>Page not found</title>', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    }),
    new Response('unavailable', { status: 503 }),
  ]) {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => response)
    assert.equal(await workersDevFetch('https://test.workers.dev/'), response)
    assert.equal(fetchMock.mock.callCount(), 1)
    fetchMock.mock.restore()
  }
})

test('does not replay ambiguous network failures', async (t) => {
  const failure = new TypeError('connection reset after write')
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw failure
  })
  await assert.rejects(workersDevFetch('https://test.workers.dev/'), (error) => error === failure)
  assert.equal(fetchMock.mock.callCount(), 1)
})

test('stops propagation retries when the request deadline aborts', async (t) => {
  const controller = new AbortController()
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    controller.abort()
    return missingRoute()
  })
  await assert.rejects(
    workersDevFetch('https://test.workers.dev/', { signal: controller.signal }),
    { name: 'AbortError' },
  )
  assert.equal(fetchMock.mock.callCount(), 1)
})
