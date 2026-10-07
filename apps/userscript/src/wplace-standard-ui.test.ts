// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { installStandardUi } from './wplace-standard-ui.js'

const ATTRIBUTE = 'data-standard-ui'
const STORAGE_KEY = 'caelestis.standard-ui.v1'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const disposers: (() => void)[] = []
const install = (): void => {
  disposers.push(installStandardUi())
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.documentElement.removeAttribute(ATTRIBUTE)
  document.body.replaceChildren()
  localStorage.clear()
  history.replaceState({}, '', '/')
})

describe('Standard UI', () => {
  it('restores a saved choice before first paint and re-applies it after Wplace clears it', async () => {
    localStorage.setItem(STORAGE_KEY, '1')
    install()

    expect(document.documentElement.hasAttribute(ATTRIBUTE)).toBe(true)

    document.documentElement.toggleAttribute(ATTRIBUTE, false)
    await flush()
    expect(document.documentElement.hasAttribute(ATTRIBUTE)).toBe(true)
  })
})
