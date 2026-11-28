import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { anySignal } from './any-signal.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A browser without `AbortSignal.any`, as Safari before 17.4. */
const withoutAny = () => {
  const { any: _, ...rest } = Object.getOwnPropertyDescriptors(AbortSignal)
  const Older = Object.defineProperties(function AbortSignal() {}, rest)
  vi.stubGlobal('AbortSignal', Older)
}

it('aborts with the first signal to abort where the browser lacks AbortSignal.any', () => {
  withoutAny()
  const first = new AbortController()
  const second = new AbortController()
  const either = anySignal([first.signal, second.signal])
  expect(either.aborted).toBe(false)
  second.abort('second')
  expect(either.aborted).toBe(true)
  expect(either.reason).toBe('second')
  first.abort('first')
  expect(either.reason).toBe('second')
})

it('is aborted from the start when a signal already is', () => {
  withoutAny()
  const done = new AbortController()
  done.abort('early')
  const either = anySignal([new AbortController().signal, done.signal])
  expect(either.aborted).toBe(true)
  expect(either.reason).toBe('early')
})

it('leaves no listener on a long-lived signal once its requests are done with', async () => {
  withoutAny()
  setFlagsFromString('--expose-gc')
  const gc = runInNewContext('gc') as () => void
  // A server connection's signal, which outlives every request made under it.
  const connection = new AbortController().signal
  let listening = 0
  const add = connection.addEventListener.bind(connection)
  const remove = connection.removeEventListener.bind(connection)
  connection.addEventListener = (...args: Parameters<typeof add>) => {
    listening++
    add(...args)
  }
  connection.removeEventListener = (...args: Parameters<typeof remove>) => {
    listening--
    remove(...args)
  }
  // A hundred requests, each with its own timeout, that finish and are dropped.
  for (let request = 0; request < 100; request++)
    anySignal([connection, new AbortController().signal])
  expect(listening).toBe(100)
  await vi.waitFor(async () => {
    gc()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(listening).toBe(0)
  })
})
