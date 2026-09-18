import { onAcceptedPaint } from '../tile-transform.js'
import {
  chargeForecast,
  formatCountdown,
  onChargesChange,
  spendCharges,
} from '../wplace-charges.js'
import { paintDockButton } from '../wplace-paint.js'
import { GAP } from './metrics.js'
import { applyWplaceTheme } from './theme.js'

/**
 * "Full in 24:45", sitting just above Wplace's Paint button.
 *
 * Wplace's own dock shows the charge count and the seconds to the *next* charge. What it never
 * says is when the pile stops growing, which is the number a painter plans around: leave now and
 * come back before charges overflow. The chip is ours, positioned over their button the way the
 * rail is positioned beside theirs, so their re-renders cannot take it away.
 */
const CHIP_ID = 'caelestis-charge-forecast'
const TICK_MS = 1_000

const chip = (): HTMLElement => {
  const existing = document.getElementById(CHIP_ID)
  if (existing !== null) return existing
  const el = document.createElement('div')
  el.id = CHIP_ID
  applyWplaceTheme(el)
  Object.assign(el.style, {
    position: 'fixed',
    zIndex: '30',
    transform: 'translateX(-50%)',
    pointerEvents: 'none',
    padding: '0.125rem 0.625rem',
    borderRadius: '9999px',
    font: '600 0.75rem/1.25rem system-ui, sans-serif',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    background: 'var(--caelestis-surface)',
    color: 'var(--caelestis-text)',
    boxShadow: 'var(--caelestis-popover-shadow)',
  })
  el.hidden = true
  document.body.appendChild(el)
  return el
}

/** Refresh the text from the projected charges; hidden until Wplace has reported any. */
export const renderChargeForecast = (): void => {
  const el = chip()
  const forecast = chargeForecast()
  if (forecast === null) {
    el.hidden = true
    return
  }
  el.hidden = false
  el.textContent = forecast.full ? 'Charges full' : `Full in ${formatCountdown(forecast.fullInMs)}`
  el.title = `${Math.floor(forecast.count)} of ${forecast.max} charges`
}

/** Follow Wplace's Paint button; called with the rail whenever their layout may have moved. */
export const positionChargeForecast = (): void => {
  const el = chip()
  const anchor = paintDockButton()?.getBoundingClientRect()
  if (anchor === undefined || anchor.width === 0) {
    el.style.visibility = 'hidden'
    return
  }
  el.style.visibility = ''
  el.style.left = `${anchor.left + anchor.width / 2}px`
  el.style.bottom = `${window.innerHeight - anchor.top + GAP / 2}px`
}

/**
 * Subscribe now; touch the DOM only once there is a body. The userscript runs at `document-start`,
 * where `document.body` is still null, and a throw here would leave the chip uninstalled for good.
 */
export const installChargeForecast = (): void => {
  // Accepted paints stamp Unix seconds; the charge clock runs on `Date.now()` milliseconds.
  onAcceptedPaint((paint) => spendCharges(paint.painted, paint.observedAt * 1_000))
  const mount = (): void => {
    onChargesChange(renderChargeForecast)
    setInterval(renderChargeForecast, TICK_MS)
    renderChargeForecast()
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true })
  } else {
    mount()
  }
}
