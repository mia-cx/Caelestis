import { resolveShortcutBindings } from '@caelestis/shared'
import { mount, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import SettingsPanel from '../src/settings/SettingsPanel.svelte'
import type { SettingsIntent, SettingsModel } from '../src/types.js'

const mounted: object[] = []
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((component) => unmount(component)))
  document.body.replaceChildren()
})

const settings = (): SettingsModel => ({
  servers: [],
  colourNavigationOrder: 'unpainted-first',
  simulatedInput: {},
  reportPaints: true,
  shareTiles: true,
  sharePresence: true,
  showPresence: true,
  showPresenceViewports: true,
  showPresenceClaims: true,
  showPresenceClaimsOnlyWhilePainting: false,
  debugLogging: false,
  performanceProfiling: false,
  notifyRegressions: true,
  notifyGriefing: false,
  notifyUpdates: true,
  notifyActivity: true,
  shortcuts: {
    platform: 'windows-linux',
    bindings: resolveShortcutBindings(),
    customised: true,
  },
  profile: { note: 'No profile recorded.', metrics: [] },
})

describe('settings panel intent boundary', () => {
  it('submits trimmed server input, changes settings, and resets independent user state', () => {
    const intents: SettingsIntent[] = []
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(SettingsPanel, {
        target,
        props: { model: settings(), onIntent: (intent) => intents.push(intent) },
      }),
    )

    const server = target.querySelector('input[aria-label="Server address"]') as HTMLInputElement
    server.value = ' https://templates.example.org '
    server.dispatchEvent(new Event('input', { bubbles: true }))
    server.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const order = target.querySelector(
      'select[aria-label="Middle-click colour order"]',
    ) as HTMLSelectElement
    order.value = 'mismatched-first'
    order.dispatchEvent(new Event('change', { bubbles: true }))
    ;(target.querySelector('input[aria-label="Template regressions"]') as HTMLInputElement).click()
    ;(
      target.querySelector(
        'button[title="Reset all shortcuts to their defaults"]',
      ) as HTMLButtonElement
    ).click()
    ;(target.querySelector('.profile-actions button') as HTMLButtonElement).click()

    expect(intents).toEqual([
      { type: 'add-server', url: 'https://templates.example.org' },
      { type: 'set-colour-navigation-order', value: 'mismatched-first' },
      { type: 'set-boolean', key: 'notifyRegressions', value: false },
      { type: 'reset-shortcut-bindings' },
      { type: 'reset-profile' },
    ])
  })

  it('switches each simulated painting feature on its own and names the flags it trips', () => {
    const intents: SettingsIntent[] = []
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(SettingsPanel, {
        target,
        props: { model: settings(), onIntent: (intent) => intents.push(intent) },
      }),
    )
    const toggle = (label: string): HTMLInputElement =>
      target.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement

    expect(toggle('Picker reads templates').closest('.row')?.textContent).toContain(
      'Wplace flags it on your account as UntrustedPalette.',
    )
    expect(toggle('Paint past skipped pixels').closest('.row')?.textContent).toContain(
      'Wplace flags it on your account as UntrustedPaintHold and UntrustedPointer.',
    )
    // Dragging extends a middle-click pick, so it waits for that switch.
    expect(toggle('Keep picking while dragging').disabled).toBe(true)
    toggle('Middle-click picks template colours').click()
    toggle('Paint past skipped pixels').click()
    expect(intents).toEqual([
      { type: 'set-simulated-input', id: 'middle-click-pick', value: true },
      { type: 'set-simulated-input', id: 'shift-paint', value: true },
    ])
  })

  it('asks to show claims only while painting, and disables that without claims', () => {
    const intents: SettingsIntent[] = []
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(SettingsPanel, {
        target,
        props: { model: settings(), onIntent: (intent) => intents.push(intent) },
      }),
    )
    const toggle = target.querySelector(
      'input[aria-label="Claims only while painting"]',
    ) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(toggle.disabled).toBe(false)
    toggle.click()
    expect(intents).toEqual([
      { type: 'set-boolean', key: 'showPresenceClaimsOnlyWhilePainting', value: true },
    ])

    const hidden = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(SettingsPanel, {
        target: hidden,
        props: { model: { ...settings(), showPresenceClaims: false } },
      }),
    )
    expect(
      (hidden.querySelector('input[aria-label="Claims only while painting"]') as HTMLInputElement)
        .disabled,
    ).toBe(true)
  })

  it('gives each clicking shortcut its own switch beside its key, naming its flag', () => {
    const intents: SettingsIntent[] = []
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(SettingsPanel, {
        target,
        props: {
          model: { ...settings(), simulatedInput: { 'cycle-colour-previous': true } },
          onIntent: (intent) => intents.push(intent),
        },
      }),
    )
    const row = (id: string): Element | null | undefined =>
      target.querySelector(`[data-caelestis-shortcut="${id}"]`)?.closest('.shortcut-row')
    const toggleOf = (id: string): HTMLInputElement | null | undefined =>
      row(id)?.querySelector('input[role="switch"]')

    expect(row('cycle-colour-next')?.querySelector('small')?.textContent).toBe(
      "Clicks Wplace's palette. Wplace flags it on your account as UntrustedPalette.",
    )
    expect(row('paint-action')?.querySelector('small')?.textContent).toBe(
      "Committing clicks Wplace's Paint button. Wplace flags it on your account as UntrustedPaintSubmit.",
    )
    expect(toggleOf('cancel-paint')).toBeNull()
    expect(toggleOf('cycle-colour-previous')?.checked).toBe(true)
    expect(toggleOf('cycle-colour-next')?.checked).toBe(false)
    toggleOf('cycle-colour-next')?.click()
    toggleOf('paint-action')?.click()
    expect(intents).toEqual([
      { type: 'set-simulated-input', id: 'cycle-colour-next', value: true },
      { type: 'set-simulated-input', id: 'paint-commit', value: true },
    ])
  })

  it('switches each Wplace patch by its own id, and hides the section when there are none', async () => {
    const intents: SettingsIntent[] = []
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(SettingsPanel, {
        target,
        props: {
          model: {
            ...settings(),
            wplacePatches: [
              { id: 'hover-canvas', label: 'Stop idle redraws', hint: 'Hint.', enabled: true },
              {
                id: 'tile-refresh',
                label: 'Download changed tiles only',
                hint: 'Hint.',
                enabled: false,
              },
            ],
          },
          onIntent: (intent) => intents.push(intent),
        },
      }),
    )
    const toggle = (label: string) =>
      target.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
    expect(toggle('Stop idle redraws').checked).toBe(true)
    expect(toggle('Download changed tiles only').checked).toBe(false)
    toggle('Stop idle redraws').click()
    toggle('Download changed tiles only').click()
    expect(intents).toEqual([
      { type: 'set-wplace-patch', id: 'hover-canvas', enabled: false },
      { type: 'set-wplace-patch', id: 'tile-refresh', enabled: true },
    ])

    const empty = document.body.appendChild(document.createElement('div'))
    mounted.push(mount(SettingsPanel, { target: empty, props: { model: settings() } }))
    expect(empty.textContent).not.toContain('Wplace performance')
  })

  it('shows release versions and warns only about an outdated server', () => {
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(SettingsPanel, {
        target,
        props: {
          model: {
            ...settings(),
            userscriptVersion: '0.15.0',
            servers: [
              {
                url: 'https://fresh.example.org',
                name: 'Fresh',
                status: 'connected',
                expanded: false,
                tokenSaved: true,
                isAdmin: false,
                version: '0.9.0 · a1b2c3d4e5f6',
              },
              {
                url: 'https://stale.example.org',
                name: 'Stale',
                status: 'connected',
                expanded: false,
                tokenSaved: true,
                isAdmin: false,
                version: '0.8.0',
                outdated: { expected: '0.9.0' },
              },
            ],
          },
        },
      }),
    )
    expect(target.querySelector('.version-line')?.textContent).toContain('Userscript 0.15.0')
    expect(target.textContent).toContain('0.9.0 · a1b2c3d4e5f6')
    expect(target.textContent).toContain('Older than this userscript expects (0.9.0)')

    const current = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(SettingsPanel, {
        target: current,
        props: {
          model: {
            ...settings(),
            servers: [
              {
                url: 'https://fresh.example.org',
                name: 'Fresh',
                status: 'connected',
                expanded: false,
                tokenSaved: true,
                isAdmin: false,
                version: '0.9.0',
              },
            ],
          },
        },
      }),
    )
    expect(current.querySelector('.version-line')).toBeNull()
    expect(current.textContent).not.toContain('Older than this userscript expects')
    expect(current.textContent).toContain('0.9.0')
  })

  it('offers import and send only while the other build is installed', () => {
    const intents: SettingsIntent[] = []
    const render = (model: SettingsModel) => {
      const target = document.body.appendChild(document.createElement('div'))
      mounted.push(
        mount(SettingsPanel, {
          target,
          props: { model, onIntent: (intent) => intents.push(intent) },
        }),
      )
      return [...target.querySelectorAll('button')].filter((button) =>
        /^(Import from|Send to) /.test(button.textContent ?? ''),
      )
    }

    const alone = render(settings())
    const both = render({ ...settings(), otherBuild: 'userscript' })
    for (const button of both) button.click()

    expect(alone).toEqual([])
    expect(both.map((button) => button.textContent?.trim())).toEqual([
      'Import from userscript',
      'Send to userscript',
    ])
    expect(intents).toEqual([{ type: 'import-from-other-build' }, { type: 'send-to-other-build' }])
  })
})
