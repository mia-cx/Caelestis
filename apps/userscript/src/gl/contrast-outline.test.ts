import { afterEach, expect, it, vi } from 'vitest'
import { isDarkMapTheme, onMapThemeChange } from './contrast-outline.js'

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
})

it('follows a theme switch without measuring styles on every frame', async () => {
  const changed = vi.fn()
  onMapThemeChange(changed)
  expect(isDarkMapTheme()).toBe(false)

  document.documentElement.dataset.theme = 'dark'
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
  expect(isDarkMapTheme()).toBe(true)

  // A theme with neither name falls back to the computed colour scheme, read once per change.
  const measure = vi.spyOn(window, 'getComputedStyle')
  document.documentElement.dataset.theme = 'custom-winter'
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
  for (let frame = 0; frame < 60; frame++) expect(isDarkMapTheme()).toBe(false)
  expect(measure).toHaveBeenCalledTimes(1)
})
