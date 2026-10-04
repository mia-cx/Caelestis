import { afterEach, describe, expect, it, vi } from 'vitest'

import { closeSurface, openSurface, surfaceCloseDurationMs } from '../src/foundations/motion.js'

const element = (duration = '150ms'): HTMLElement => {
  const el = document.createElement('div')
  el.style.setProperty('--caelestis-surface-close-duration', duration)
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('closeSurface', () => {
  it('runs finish after the declared duration, not before', () => {
    vi.useFakeTimers()
    const el = element()
    const finish = vi.fn()
    closeSurface(el, finish)
    expect(el.dataset.state).toBe('closing')
    expect(finish).not.toHaveBeenCalled()
    vi.advanceTimersByTime(149)
    expect(finish).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(el.dataset.state).toBeUndefined()
  })

  it('finishes immediately under reduced motion', () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', () => ({ matches: true }) as MediaQueryList)
    const el = element()
    const finish = vi.fn()
    closeSurface(el, finish)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(el.dataset.state).toBeUndefined()
  })

  it('finishes immediately when the duration resolves to zero', () => {
    vi.useFakeTimers()
    const el = element('0ms')
    const finish = vi.fn()
    closeSurface(el, finish)
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('lets a reopen cancel the pending close and clear the closing state', () => {
    vi.useFakeTimers()
    const el = element()
    const finish = vi.fn()
    const cancel = closeSurface(el, finish)
    expect(el.dataset.state).toBe('closing')
    cancel()
    expect(el.dataset.state).toBeUndefined()
    vi.advanceTimersByTime(10_000)
    expect(finish).not.toHaveBeenCalled()
    expect(el.isConnected).toBe(true)
  })
})

describe('openSurface', () => {
  it('marks the surface open on the next frame and cancels an in-flight close', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
      run(0)
      return 0
    })
    const el = element()
    const finish = vi.fn()
    closeSurface(el, finish)
    openSurface(el)
    expect(el.dataset.state).toBe('open')
    vi.advanceTimersByTime(10_000)
    expect(finish).not.toHaveBeenCalled()
  })
})

describe('surfaceCloseDurationMs', () => {
  it('reads ms and s values from the element property', () => {
    expect(surfaceCloseDurationMs(element('0.2s'))).toBe(200)
    expect(surfaceCloseDurationMs(element('42ms'))).toBe(42)
  })
})
