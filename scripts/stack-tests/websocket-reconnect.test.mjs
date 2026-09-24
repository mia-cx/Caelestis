import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitFor } from './acceptance.mjs'
import { reconnectWebSocket, WebSocketDisconnected } from './websocket-reconnect.mjs'

test('replays a disconnected exchange with a fresh connection', async () => {
  let connections = 0
  const result = reconnectWebSocket(async () => {
    connections++
    if (connections === 1) throw new WebSocketDisconnected('deployment replaced the object')
    return 'duplicate'
  })
  assert.equal(await result, 'duplicate')
  assert.equal(connections, 2)
})

test('does not retry an application failure after reconnecting', async () => {
  let connections = 0
  const result = reconnectWebSocket(async () => {
    connections++
    if (connections === 1) throw new WebSocketDisconnected('deployment')
    assert.equal('recorded', 'duplicate', 'the previous event must survive the redeploy')
  })
  const rejected = assert.rejects(result, assert.AssertionError)
  await rejected
  assert.equal(connections, 2)
})

test('bounds persistent disconnects to three attempts', async () => {
  let connections = 0
  const result = reconnectWebSocket(async () => {
    connections++
    throw new WebSocketDisconnected('offline')
  })
  const rejected = assert.rejects(result, WebSocketDisconnected)
  await rejected
  assert.equal(connections, 3)
})

test('message waits surface transport failure immediately rather than hiding it as a timeout', async () => {
  const disconnected = new WebSocketDisconnected('closed')
  await assert.rejects(
    waitFor(
      () => {
        throw disconnected
      },
      'message',
      20_000,
      false,
    ),
    (error) => error === disconnected,
  )
})
