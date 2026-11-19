import type { Attachment } from 'svelte/attachments'

/** Enter blurs the field, which commits a typed value through its `change` event. */
export const commitOnEnter: Attachment<HTMLInputElement> = (input) => {
  const keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') input.blur()
  }
  input.addEventListener('keydown', keydown)
  return () => input.removeEventListener('keydown', keydown)
}
