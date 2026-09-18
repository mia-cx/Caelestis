// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcceptedPaint } from '../tile-transform.js'
import { chargeForecast, observeCharges, resetCharges } from '../wplace-charges.js'
import {
  installChargeForecast,
  positionChargeForecast,
  renderChargeForecast,
} from './charge-forecast.js'

const acceptedPaintListeners: Array<(paint: AcceptedPaint) => void> = []
vi.mock('../tile-transform.js', () => ({
  onAcceptedPaint: (listener: (paint: AcceptedPaint) => void) => {
    acceptedPaintListeners.push(listener)
    return () => {}
  },
}))

const chip = (): HTMLElement => document.getElementById('caelestis-charge-forecast') as HTMLElement

const mountPaintDock = (rect: Partial<DOMRect>): HTMLButtonElement => {
  const dock = document.createElement('div')
  dock.className = 'absolute left-1/2 -translate-x-1/2 bottom-3'
  const button = document.createElement('button')
  button.className = 'btn btn-primary btn-lg'
  button.textContent = 'Paint 12'
  button.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 0, height: 0, ...rect }) as DOMRect
  dock.append(button)
  document.body.append(dock)
  return button
}

beforeEach(() => document.body.replaceChildren())
afterEach(() => {
  resetCharges()
  vi.useRealTimers()
})

describe('charge forecast chip', () => {
  it('stays hidden until Wplace reports charges, then counts down to full', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    renderChargeForecast()
    expect(chip().hidden).toBe(true)

    observeCharges({ count: 58, max: 60, cooldownMs: 30_000 }, 0)
    renderChargeForecast()
    expect(chip().hidden).toBe(false)
    expect(chip().textContent).toBe('Full in 1:00')
    expect(chip().title).toBe('58 of 60 charges')

    vi.setSystemTime(60_000)
    renderChargeForecast()
    expect(chip().textContent).toBe('Charges full')
  })

  it('spends accepted paints on the millisecond charge clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    installChargeForecast()
    observeCharges({ count: 10, max: 60, cooldownMs: 30_000 }, 0)

    vi.setSystemTime(30_000)
    const listener = acceptedPaintListeners.at(-1)
    expect(listener).toBeDefined()
    listener?.({ painted: 4, observedAt: 30 } as AcceptedPaint)

    expect(chargeForecast(30_000)?.count).toBe(7)
    expect(chip().textContent).toBe('Full in 26:30')
  })

  it('sits centred above the Paint button and hides when there is none', () => {
    window.innerHeight = 800
    mountPaintDock({ left: 300, top: 740, width: 120, height: 48 })
    positionChargeForecast()
    expect(chip().style.visibility).toBe('')
    expect(chip().style.left).toBe('360px')
    expect(chip().style.bottom).toBe('66px')

    document.body.replaceChildren(chip())
    positionChargeForecast()
    expect(chip().style.visibility).toBe('hidden')
  })
})
