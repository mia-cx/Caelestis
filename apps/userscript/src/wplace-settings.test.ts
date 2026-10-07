// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { installWplaceSettings } from './wplace-settings.js'

const STORAGE_KEY = 'caelestis.wplace-options.v1'
const FALSETYPE_ATTRIBUTE = 'data-caelestis-falsetype'

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
    'data-caelestis-cursors',
  ])
    document.documentElement.removeAttribute(attribute)
  document.body.replaceChildren()
  localStorage.clear()
  history.replaceState({}, '', '/')
})

describe('Wplace settings rows', () => {
  it('inserts the FalseType row between Wplace’s Pixelated fonts and native cursor rows', async () => {
    install()
    mountPanel()
    await flush()

    expect(labels()).toEqual([
      'Legacy UI',
      'Pixelated fonts',
      'FalseType font',
      'Use native OS cursor',
    ])

    const pixelFonts = [...document.querySelectorAll('#settings-panel-accessibility label')].find(
      (label) => !label.hasAttribute('data-caelestis-option'),
    )
    expect(pixelFonts).toBeDefined()
    expect(ourRow('falseType').className).toBe(pixelFonts?.className)
    expect(ourInput('falseType').checked).toBe(true)
    expect(ourRow('falseType').querySelector('a.link')?.getAttribute('href')).toBe(
      'https://github.com/patchstep/FalseType',
    )
    expect(document.documentElement.hasAttribute(FALSETYPE_ATTRIBUTE)).toBe(false)
  })

  it('switches off with an opt-out attribute and persists across installs', async () => {
    install()
    mountPanel()
    await flush()

    ourInput('falseType').click()
    expect(ourInput('falseType').checked).toBe(false)
    expect(document.documentElement.getAttribute(FALSETYPE_ATTRIBUTE)).toBe('off')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').falseType).toBe(false)

    // A fresh install after dispose restores the choice before any panel exists.
    for (const dispose of disposers.splice(0)) dispose()
    document.body.replaceChildren()
    install()
    expect(document.documentElement.getAttribute(FALSETYPE_ATTRIBUTE)).toBe('off')
    mountPanel()
    await flush()
    expect(ourInput('falseType').checked).toBe(false)
  })

  it('disables the row while its dependencies are off and restores it after', async () => {
    install()
    mountPanel()
    await flush()

    document.documentElement.setAttribute('data-pixel-fonts', 'false')
    await flush()
    const row = ourRow('falseType')
    expect(ourInput('falseType').disabled).toBe(true)
    expect(ourInput('falseType').checked).toBe(false)
    expect(row.classList.contains('opacity-60')).toBe(true)

    document.documentElement.removeAttribute('data-pixel-fonts')
    await flush()
    expect(ourInput('falseType').disabled).toBe(false)
    expect(ourInput('falseType').checked).toBe(true)
    expect(row.classList.contains('opacity-60')).toBe(false)

    document.documentElement.setAttribute('data-standard-ui', '')
    await flush()
    expect(ourInput('falseType').disabled).toBe(true)
    expect(row.classList.contains('opacity-60')).toBe(true)
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
