import { type NotificationsModel, registerCaelestisUi } from '@caelestis/ui/elements'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../state.js', () => ({ getState: () => ({}) }))
vi.mock('./theme.js', () => ({ applyWplaceTheme: () => {} }))

import { requestConfirmation, showOneTimeSecret } from './notification-host.js'

registerCaelestisUi()

afterEach(async () => {
  document.body.replaceChildren()
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
})

const host = () =>
  document.querySelector('caelestis-notifications') as HTMLElement & {
    model: NotificationsModel
  }

it.each(['confirm', 'cancel', 'escape'] as const)(
  'resolves %s immediately through the real owner while retaining the closed confirmation shell',
  async (path) => {
    vi.useFakeTimers()
    const resolved = vi.fn()
    const result = requestConfirmation({
      title: 'Delete',
      body: 'Delete this template?',
      note: '',
      confirmLabel: 'Delete',
      restoreFocusTo: null,
    }).then(resolved)
    await vi.advanceTimersByTimeAsync(0)
    const owner = host()
    const dialog = owner.shadowRoot?.querySelector('dialog') as HTMLDialogElement
    dialog.style.setProperty('--caelestis-surface-close-duration', '150ms')
    expect(dialog.open).toBe(true)

    if (path === 'escape') dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    else
      (dialog.querySelector(path === 'confirm' ? '.danger' : '.quiet') as HTMLButtonElement).click()

    expect(owner.model.confirm).toBeNull()
    expect(dialog.open).toBe(false)
    await result
    expect(resolved).toHaveBeenCalledWith(path === 'confirm')
    await vi.advanceTimersByTimeAsync(0)
    expect(dialog.isConnected).toBe(true)
    expect(dialog.textContent).toContain('Delete this template?')
    await vi.advanceTimersByTimeAsync(149)
    expect(dialog.isConnected).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(dialog.isConnected).toBe(false)
  },
)

it('keeps the one-time secret acknowledgement immediate and still refuses Escape', async () => {
  vi.useFakeTimers()
  const resolved = vi.fn()
  const result = showOneTimeSecret('Admin', 'secret-token').then(resolved)
  await vi.advanceTimersByTimeAsync(0)
  const owner = host()
  const dialog = owner.shadowRoot?.querySelector('dialog') as HTMLDialogElement
  dialog.style.setProperty('--caelestis-surface-close-duration', '150ms')
  const cancelEvent = new Event('cancel', { cancelable: true })
  dialog.dispatchEvent(cancelEvent)
  expect(cancelEvent.defaultPrevented).toBe(true)
  expect(dialog.open).toBe(true)

  ;(dialog.querySelector('.quiet') as HTMLButtonElement).click()
  expect(owner.model.oneTimeSecret).toBeNull()
  expect(dialog.open).toBe(false)
  await result
  expect(resolved).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(0)
  expect(dialog.isConnected).toBe(true)
  expect((dialog.querySelector('input') as HTMLInputElement).value).toBe('secret-token')
  await vi.advanceTimersByTimeAsync(150)
  expect(dialog.isConnected).toBe(false)
})
