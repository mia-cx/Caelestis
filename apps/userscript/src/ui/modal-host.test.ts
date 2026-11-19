// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'

vi.mock('./theme.js', () => ({ applyWplaceTheme: vi.fn() }))

import { openModalHost } from './modal-host.js'

it('returns focus to the control inside a shadow root that had it when the dialog opened', () => {
  const panel = document.body.appendChild(document.createElement('div'))
  const row = panel.attachShadow({ mode: 'open' }).appendChild(document.createElement('button'))
  row.focus()
  openModalHost(
    'caelestis-tag-manager',
    {
      owner: 'Local · This browser',
      tags: [],
      selected: [],
      loading: false,
      ready: true,
      busy: false,
      revision: 0,
    },
    { onIntent: vi.fn() },
  )
  const dialog = document.querySelector('caelestis-tag-manager')!
  const intend = (type: 'close' | 'closed') =>
    dialog.dispatchEvent(new CustomEvent('caelestis-tag-manager-intent', { detail: { type } }))
  intend('close')
  expect(dialog.model.open).toBe(false)
  row.blur()
  intend('closed')
  expect(dialog.isConnected).toBe(false)
  expect(panel.shadowRoot?.activeElement).toBe(row)
})
