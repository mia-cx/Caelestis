// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { installStandardUi } from './wplace-standard-ui.js'

const ATTRIBUTE = 'data-standard-ui'
const STORAGE_KEY = 'caelestis.standard-ui.v1'
const WPLACE_SETTINGS_KEY = 'wplace:settings:v1'

/** Wplace's Accessibility settings panel, lifted verbatim from the live bundle's markup. */
const PANEL_HTML = `<div id="settings-panel-accessibility"><!----><label class="border-base-content/10 flex min-h-14 cursor-pointer items-center justify-between gap-4 border-b py-3 text-sm"><span class="min-w-0"><span class="font-medium">Pixelated fonts</span><!----></span> <input class="toggle toggle-primary toggle-sm shrink-0" type="checkbox"></label><!----> <div class="border-base-content/10 border-b py-4"><label for="settings-colorblind-mode" class="mb-2 block text-sm font-medium">Colorblind filter</label> <select id="settings-colorblind-mode" class="select min-h-11 w-full"></select></div></div>`

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const panel = (): HTMLElement => {
  document.body.innerHTML = PANEL_HTML
  const element = document.getElementById('settings-panel-accessibility')
  if (!element) throw new Error('fixture did not mount')
  return element
}

const pixelRow = (): HTMLElement => {
  const row = panel().querySelector('input.toggle[type="checkbox"]')?.closest('label')
  if (!(row instanceof HTMLElement)) throw new Error('no pixel fonts row')
  return row
}

const ourRow = (): HTMLElement | null => document.querySelector('label[data-caelestis-standard-ui]')

const ourInput = (): HTMLInputElement => {
  const input = ourRow()?.querySelector('input[type="checkbox"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('no Pixelated UI switch')
  return input
}

const disposers: (() => void)[] = []
const install = (): void => {
  disposers.push(installStandardUi())
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.documentElement.removeAttribute(ATTRIBUTE)
  document.body.replaceChildren()
  document.head.replaceChildren()
  localStorage.clear()
  history.replaceState({}, '', '/')
})

describe('Pixelated UI switch', () => {
  it('restores a saved choice before first paint and re-applies it after Wplace clears it', async () => {
    localStorage.setItem(STORAGE_KEY, '1')
    install()

    expect(document.documentElement.hasAttribute(ATTRIBUTE)).toBe(true)

    document.documentElement.toggleAttribute(ATTRIBUTE, false)
    await flush()
    expect(document.documentElement.hasAttribute(ATTRIBUTE)).toBe(true)
  })

  it("falls back to the browser's own cursors under standard UI", () => {
    const sheet = document.createElement('style')
    // Wplace's pixel cursor shape: an SVG data URL with the keyword as fallback.
    sheet.textContent = ':root{--cursor-pointer:url("data:image/svg+xml,x") 1 1, pointer}'
    document.head.append(sheet)
    localStorage.setItem(STORAGE_KEY, '1')
    install()

    const cursorValue = (): string =>
      getComputedStyle(document.documentElement).getPropertyValue('--cursor-pointer').trim()
    expect(cursorValue()).toBe('pointer')

    document.documentElement.removeAttribute(ATTRIBUTE)
    expect(cursorValue()).toContain('url(')
  })

  it('adds a Pixelated UI switch under Pixelated fonts that switches and persists', async () => {
    install()
    const pixel = pixelRow()
    await flush()

    const row = ourRow()
    expect(row).toBe(pixel.nextElementSibling)
    expect(row?.className).toBe(pixel.className)
    expect(row?.textContent).toContain('Pixelated UI')
    expect(ourInput().checked).toBe(true)

    // Unchecking the switch applies the standard UI.
    ourInput().click()
    expect(ourInput().checked).toBe(false)
    expect(document.documentElement.hasAttribute(ATTRIBUTE)).toBe(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1')

    // A fresh install after dispose reads the saved choice and unchecks the switch.
    for (const dispose of disposers.splice(0)) dispose()
    install()
    expect(ourInput().checked).toBe(false)

    ourInput().click()
    expect(ourInput().checked).toBe(true)
    expect(document.documentElement.hasAttribute(ATTRIBUTE)).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('0')
  })

  it("leaves Wplace's own attribute alone when re-checked on the dashboard", async () => {
    history.replaceState({}, '', '/dashboard')
    localStorage.setItem(STORAGE_KEY, '1')
    install()
    pixelRow()
    await flush()

    ourInput().click()

    expect(ourInput().checked).toBe(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('0')
    expect(document.documentElement.hasAttribute(ATTRIBUTE)).toBe(true)
  })

  it.each<[string, () => void, () => void]>([
    [
      'a native Standard UI label in the panel',
      () => {},
      () => {
        const native = pixelRow().cloneNode(true) as HTMLElement
        const text = native.querySelector('.font-medium')
        if (text) text.textContent = 'Standard UI'
        pixelRow().after(native)
      },
    ],
    [
      'a native Pixelated UI label in the panel',
      () => {},
      () => {
        const native = pixelRow().cloneNode(true) as HTMLElement
        const text = native.querySelector('.font-medium')
        if (text) text.textContent = 'Pixelated UI'
        pixelRow().after(native)
      },
    ],
    [
      'a standard key in wplace:settings:v1',
      () => localStorage.setItem(WPLACE_SETTINGS_KEY, JSON.stringify({ standardUi: true })),
      () => {},
    ],
  ])(
    'steps aside once Wplace offers its own option: %s',
    async (_name, beforeInstall, afterMount) => {
      localStorage.setItem(STORAGE_KEY, '1')
      beforeInstall()
      install()
      pixelRow()
      afterMount()
      await flush()

      expect(ourRow()).toBeNull()

      document.documentElement.toggleAttribute(ATTRIBUTE, false)
      await flush()
      expect(document.documentElement.hasAttribute(ATTRIBUTE)).toBe(false)
    },
  )
})
