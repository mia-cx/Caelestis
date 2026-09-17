import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chargeForecast,
  formatCountdown,
  observeCharges,
  onChargesChange,
  resetCharges,
  spendCharges,
} from './wplace-charges.js'

afterEach(resetCharges)

describe('charge forecast', () => {
  it('projects regeneration from one reading', () => {
    expect(observeCharges({ count: 10.5, max: 60, cooldownMs: 30_000 }, 0)).toBe(true)

    expect(chargeForecast(0)).toEqual({ count: 10.5, max: 60, full: false, fullInMs: 1_485_000 })
    expect(chargeForecast(60_000)?.count).toBe(12.5)
    expect(chargeForecast(10_000_000)).toEqual({ count: 60, max: 60, full: true, fullInMs: 0 })
  })

  it('spends accepted paints against the projected count', () => {
    const changed = vi.fn()
    onChargesChange(changed)
    observeCharges({ count: 10, max: 60, cooldownMs: 30_000 }, 0)
    spendCharges(4, 30_000)

    expect(chargeForecast(30_000)?.count).toBe(7)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('ignores readings that are missing or malformed', () => {
    expect(observeCharges(undefined)).toBe(false)
    expect(observeCharges({ count: 'ten', max: 60, cooldownMs: 30_000 })).toBe(false)
    expect(observeCharges({ count: 1, max: 0, cooldownMs: 30_000 })).toBe(false)
    expect(chargeForecast()).toBeNull()
    spendCharges(1)
    expect(chargeForecast()).toBeNull()
  })

  it('formats countdowns rounded up to the second', () => {
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(1)).toBe('0:01')
    expect(formatCountdown(1_485_000)).toBe('24:45')
    expect(formatCountdown(3_661_000)).toBe('1:01:01')
  })
})
