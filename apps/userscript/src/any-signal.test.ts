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
