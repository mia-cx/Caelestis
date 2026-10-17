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

it('lets an invite be selected after clipboard denial without losing the token copy result', async () => {
  vi.useFakeTimers()
  vi.spyOn(navigator.clipboard, 'writeText')
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error('Clipboard permission denied'))
  const invite = 'https://wplace.live/#aHR0cHM6Ly9leGFtcGxlLmNvbQ.c2VjcmV0LXRva2Vu'
  const result = showOneTimeSecret('Reader', 'secret-token', invite)
  await vi.advanceTimersByTimeAsync(0)
  const owner = host()
  const root = owner.shadowRoot
  const copyToken = root?.querySelector<HTMLButtonElement>('[aria-label="Copy token"]')
  const copyInvite = root?.querySelector<HTMLButtonElement>('[aria-label="Copy invite link"]')
  const inviteField = root?.querySelector<HTMLInputElement>('input[aria-label="Invite link"]')
  if (copyToken == null || copyInvite == null || inviteField == null)
    throw new Error('Missing token and invite dialog')
  copyToken.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(copyToken.textContent).toBe('Copied token')
  copyInvite.focus()
  copyInvite.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(copyInvite.textContent).toBe('Select link')
  expect(root?.activeElement).toBe(copyInvite)
  expect(copyToken.textContent).toBe('Copied token')
  copyInvite.click()
  expect(root?.activeElement).toBe(inviteField)
  expect(inviteField.selectionStart).toBe(0)
  expect(inviteField.selectionEnd).toBe(invite.length)
  root?.querySelector<HTMLButtonElement>('.quiet')?.click()
  await result
  expect(owner.model.oneTimeSecret).toBeNull()
})
