// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { SURFACE_RADIUS } from './metrics.js'
import { applyWplaceTheme } from './theme.js'

const themed = (): HTMLElement => {
  const el = document.createElement('div')
  document.body.append(el)
  applyWplaceTheme(el)
  return el
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

afterEach(() => {
  document.documentElement.removeAttribute('data-game-ui')
  document.documentElement.removeAttribute('data-standard-ui')
  document.body.replaceChildren()
})

it('paints pixel tokens when the root has data-game-ui and no data-standard-ui', () => {
  document.documentElement.setAttribute('data-game-ui', '')
  const el = themed()
  expect(el.dataset.caelestisStyle).toBe('pixel')
  expect(el.style.getPropertyValue('--caelestis-radius')).toBe('0')
})

it('repaints live when data-standard-ui appears and disappears', async () => {
  document.documentElement.setAttribute('data-game-ui', '')
  const el = themed()
  expect(el.dataset.caelestisStyle).toBe('pixel')

  document.documentElement.setAttribute('data-standard-ui', '')
  await flush()
  expect(el.dataset.caelestisStyle).toBe('classic')
  expect(el.style.getPropertyValue('--caelestis-radius')).toBe(SURFACE_RADIUS)

  document.documentElement.removeAttribute('data-standard-ui')
  await flush()
  expect(el.dataset.caelestisStyle).toBe('pixel')
  expect(el.style.getPropertyValue('--caelestis-radius')).toBe('0')
})

it('paints classic when the root lacks data-game-ui', () => {
  const el = themed()
  expect(el.dataset.caelestisStyle).toBe('classic')
  expect(el.style.getPropertyValue('--caelestis-radius')).toBe(SURFACE_RADIUS)
})
