// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { installWplaceSettings } from './wplace-settings.js'

const STORAGE_KEY = 'caelestis.wplace-options.v1'
const FALSETYPE_ATTRIBUTE = 'data-caelestis-falsetype'
const CURSORS_ATTRIBUTE = 'data-caelestis-cursors'

/** Wplace's own Accessibility row markup, lifted verbatim from the live bundle. */
const wplaceRow = (label: string): string =>
  `<label class="border-base-content/10 flex min-h-14 cursor-pointer items-center justify-between gap-4 border-b py-3 text-sm"><span class="min-w-0"><span class="font-medium">${label}</span><!----></span> <input class="toggle toggle-primary toggle-sm shrink-0" type="checkbox"></label>`

const PANEL_HTML = `<div id="settings-panel-accessibility"><!---->${wplaceRow('Legacy UI')}<!---->${wplaceRow('Pixelated fonts')}<!---->${wplaceRow('Use native OS cursor')}<!----> <div class="border-base-content/10 border-b py-4"><label for="settings-colorblind-mode" class="mb-2 block text-sm font-medium">Colorblind filter</label> <select id="settings-colorblind-mode" class="select min-h-11 w-full"></select></div></div>`

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const mountPanel = (html = PANEL_HTML): HTMLElement => {
  document.body.innerHTML = html
  const element = document.getElementById('settings-panel-accessibility')
  if (!element) throw new Error('fixture did not mount')
  return element
}

const labels = (): string[] =>
  [...document.querySelectorAll('#settings-panel-accessibility label .font-medium')].map(
    (element) => element.textContent ?? '',
  )

const ourRow = (key: string): HTMLElement =>
  document.querySelector(`label[data-caelestis-option="${key}"]`) ??
  (() => {
    throw new Error(`no ${key} row`)
  })()

const ourInput = (key: string): HTMLInputElement => {
  const input = ourRow(key).querySelector('input[type="checkbox"]')
  if (!(input instanceof HTMLInputElement)) throw new Error(`no ${key} switch`)
  return input
}

const disposers: (() => void)[] = []
const install = (): void => {
  disposers.push(installWplaceSettings())
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const attribute of [
    'data-standard-ui',
    'data-pixel-fonts',
    'data-native-cursor',
    FALSETYPE_ATTRIBUTE,
    CURSORS_ATTRIBUTE,
  ])
    document.documentElement.removeAttribute(attribute)
  document.body.replaceChildren()
  localStorage.clear()
  history.replaceState({}, '', '/')
})

describe('Wplace settings rows', () => {
  it('inserts our rows between Wplace’s, matching its look', async () => {
    install()
    mountPanel()
    await flush()

    expect(labels()).toEqual([
      'Legacy UI',
      'Pixelated fonts',
      'FalseType font',
      'Use native OS cursor',
      'Caelestis cursors',
    ])

    const pixelFonts = [...document.querySelectorAll('#settings-panel-accessibility label')].find(
      (label) => !label.hasAttribute('data-caelestis-option'),
    )
    expect(pixelFonts).toBeDefined()
    for (const key of ['falseType', 'cursors']) {
      expect(ourRow(key).className).toBe(pixelFonts?.className)
      expect(ourInput(key).checked).toBe(true)
    }
    expect(ourRow('falseType').querySelector('a.link')?.getAttribute('href')).toBe(
      'https://github.com/patchstep/FalseType',
    )
    expect(document.documentElement.hasAttribute(FALSETYPE_ATTRIBUTE)).toBe(false)
    expect(document.documentElement.hasAttribute(CURSORS_ATTRIBUTE)).toBe(false)
  })

  it('switches each row off with an opt-out attribute and persists across installs', async () => {
    install()
    mountPanel()
    await flush()

    ourInput('falseType').click()
    ourInput('cursors').click()
    expect(ourInput('falseType').checked).toBe(false)
    expect(ourInput('cursors').checked).toBe(false)
    expect(document.documentElement.getAttribute(FALSETYPE_ATTRIBUTE)).toBe('off')
    expect(document.documentElement.getAttribute(CURSORS_ATTRIBUTE)).toBe('off')
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.falseType).toBe(false)
    expect(stored.cursors).toBe(false)

    // A fresh install after dispose restores the choices before any panel exists.
    for (const dispose of disposers.splice(0)) dispose()
    document.body.replaceChildren()
    install()
    expect(document.documentElement.getAttribute(FALSETYPE_ATTRIBUTE)).toBe('off')
    expect(document.documentElement.getAttribute(CURSORS_ATTRIBUTE)).toBe('off')
    mountPanel()
    await flush()
    expect(ourInput('falseType').checked).toBe(false)
    expect(ourInput('cursors').checked).toBe(false)
  })

  it('disables rows while their dependencies are off and restores them after', async () => {
    install()
    mountPanel()
    await flush()

    const root = document.documentElement
    const disabled = (key: string): boolean =>
      ourInput(key).disabled && ourRow(key).classList.contains('opacity-60')

    root.setAttribute('data-pixel-fonts', 'false')
    await flush()
    expect(disabled('falseType')).toBe(true)
    expect(ourInput('falseType').checked).toBe(false)
    expect(disabled('cursors')).toBe(false)

    root.removeAttribute('data-pixel-fonts')
    await flush()
    expect(disabled('falseType')).toBe(false)
    expect(ourInput('falseType').checked).toBe(true)

    root.setAttribute('data-native-cursor', '')
    await flush()
    expect(disabled('cursors')).toBe(true)
    expect(ourInput('cursors').checked).toBe(false)
    expect(disabled('falseType')).toBe(false)

    root.removeAttribute('data-native-cursor')
    root.setAttribute('data-standard-ui', '')
    await flush()
    expect(disabled('falseType')).toBe(true)
    expect(disabled('cursors')).toBe(true)
  })

  it('injects nothing when fewer than three Wplace rows are present', async () => {
    install()
    mountPanel(
      `<div id="settings-panel-accessibility">${wplaceRow('Legacy UI')}${wplaceRow('Pixelated fonts')}</div>`,
    )
    await flush()

    expect(document.querySelector('label[data-caelestis-option]')).toBeNull()
  })
})
