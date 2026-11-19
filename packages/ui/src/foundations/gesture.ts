import type { Attachment } from 'svelte/attachments'

const STEP_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

/**
 * Commits once when a previewing gesture on a slider-like control ends: a pointer release, the
 * release of a held step key, a `change` outside a key hold, or leaving the control. The control
 * previews on its own; `commit` must do nothing when nothing is pending.
 */
export const commitOnGestureEnd =
  (commit: () => void): Attachment<HTMLElement> =>
  (node) => {
    const listeners = new AbortController()
    const { signal } = listeners
    let keyHeld = false
    node.addEventListener(
      'keydown',
      (event) => {
        if (STEP_KEYS.has(event.key)) keyHeld = true
      },
      { signal },
    )
    node.addEventListener(
      'keyup',
      (event) => {
        if (!keyHeld || !STEP_KEYS.has(event.key)) return
        keyHeld = false
        commit()
      },
      { signal },
    )
    node.addEventListener(
      'change',
      () => {
        if (!keyHeld) commit()
      },
      { signal },
    )
    for (const end of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur'] as const) {
      node.addEventListener(end, commit, { signal })
    }
    return () => listeners.abort()
  }
