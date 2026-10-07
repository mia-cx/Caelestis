/**
 * Shared open/close orchestration for surfaces that are mounted and removed from the DOM rather
 * than toggled by the top layer (popover/dialog). The CSS side reads `data-state` ("open" |
 * "closing") and declares its own durations via `--caelestis-surface-close-duration`, so timing
 * lives next to the transition it drives.
 *
 * Close must outlive the decision that caused it: `closeSurface` keeps the element and flips it to
 * `data-state="closing"` for the declared close duration, then runs `finish` — usually `remove()`
 * or dropping a `{#if}` flag. The returned cancel function is what makes a reopen during a close
 * reverse from the current frame instead of snapping back to the closing scale.
 */

import { quintOut } from 'svelte/easing'
import type { EasingFunction, TransitionConfig } from 'svelte/transition'

export const SURFACE_CLOSE_DURATION = '--caelestis-surface-close-duration'

/** Tail margin after a transition's duration before held state (closing rows, control glides) is released. */
export const SETTLE_MARGIN_MS = 50

export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const parseDurationMs = (value: string): number => {
  const trimmed = value.trim()
  if (trimmed.endsWith('ms')) return Number.parseFloat(trimmed) || 0
  if (trimmed.endsWith('s')) return (Number.parseFloat(trimmed) || 0) * 1000
  return Number.parseFloat(trimmed) || 0
}

/** The element's declared close duration in milliseconds; 0 means "close instantly". */
export const surfaceCloseDurationMs = (
  element: HTMLElement,
  property: string = SURFACE_CLOSE_DURATION,
): number => parseDurationMs(getComputedStyle(element).getPropertyValue(property))

/** Wrap a Svelte transition so its duration comes from `token` on the node (0 under reduced motion) and it eases with quintOut, which is --caelestis-ease-smooth-out's curve. */
export const tokenized =
  <P extends { duration?: number; easing?: EasingFunction }>(
    transition: (node: Element, params?: P) => TransitionConfig,
    token: string,
  ) =>
  (node: Element, params?: P): TransitionConfig =>
    transition(node, {
      easing: quintOut,
      ...params,
      duration: prefersReducedMotion() ? 0 : surfaceCloseDurationMs(node as HTMLElement, token),
    } as P)

interface ShiftParams {
  /** Token holding the travel distance, read from the node. */
  distance?: string
  /** -1/0/1 multiplier on `distance` along each axis. */
  dx?: number
  dy?: number
  /** Token holding the hidden-state scale, read from the node (1 = none). */
  scale?: string
  /** Token holding the hidden-state blur, read from the node. */
  blur?: string
  duration?: number
  easing?: EasingFunction
}

/** Fade with an optional token-sized translate (dx/dy are -1/0/1 multipliers of `distance`), scale and blur. Wrap with `tokenized` for the duration. */
export const shift = (node: Element, params?: ShiftParams): TransitionConfig => {
  const { distance, dx = 0, dy = 0, scale, blur, duration = 0, easing } = params ?? {}
  const style = getComputedStyle(node as HTMLElement)
  const travel =
    distance === undefined ? 0 : Number.parseFloat(style.getPropertyValue(distance)) || 0
  const from = scale === undefined ? 1 : Number.parseFloat(style.getPropertyValue(scale)) || 1
  const blurPx = blur === undefined ? 0 : Number.parseFloat(style.getPropertyValue(blur)) || 0
  const x = dx * travel
  const y = dy * travel
  return {
    duration,
    ...(easing === undefined ? {} : { easing }),
    css: (t, u) =>
      `opacity: ${t}; transform: translate(${u * x}px, ${u * y}px) scale(${1 - (1 - from) * u}); filter: blur(${(1 - t) * blurPx}px)`,
  }
}

const pendingCloses = new WeakMap<HTMLElement, number>()
const pendingOpens = new WeakMap<HTMLElement, number>()
/** Frames `openSurface` waits for a custom element's shadow styles before opening it anyway. */
const MAX_STYLE_WAIT_FRAMES = 40

const cancelSurfaceOpen = (element: HTMLElement): void => {
  const frame = pendingOpens.get(element)
  if (frame === undefined) return
  cancelAnimationFrame(frame)
  pendingOpens.delete(element)
  // The pending open may still be holding the element hidden and transition-less.
  element.style.visibility = ''
  element.style.transition = ''
}

/** Cancel a pending close on `element`, if one is running. Returns whether there was one. */
export const cancelSurfaceClose = (element: HTMLElement): boolean => {
  const timer = pendingCloses.get(element)
  if (timer === undefined) return false
  clearTimeout(timer)
  pendingCloses.delete(element)
  element.removeAttribute('data-state')
  return true
}

/**
 * Mark a freshly mounted surface as open on the next frame so the entrance transition runs from
 * its resting (closed) style. Cancels an in-flight close first: reopening mid-close continues from
 * wherever the animation currently is.
 */
export const openSurface = (element: HTMLElement): void => {
  cancelSurfaceOpen(element)
  // Reopening a still-closing element continues from the current frame, so it stays visible.
  const reuse = cancelSurfaceClose(element)
  if (!reuse) {
    // A custom element's shadow styles attach a task or more after connection, and the jump from
    // unstyled to styled-hidden is itself a transition — flipping data-state before it settles
    // lands mid-attach and the entrance never runs. Hold the element invisible with transitions
    // off until the styles exist and a frame has rendered the hidden state, then unhide, restore
    // transitions, and flip. A plain element is ready immediately.
    element.style.visibility = 'hidden'
    element.style.transition = 'none'
  }
  element.removeAttribute('data-state')
  let attempts = 0
  const open = (): void => {
    pendingOpens.delete(element)
    const styled = element.shadowRoot === null || element.shadowRoot.querySelector('style') !== null
    // `reuse` renders already and reverses the closing animation where it is; a fresh element
    // needs one rendered frame of the hidden style or the flip has no start state.
    const ready = styled && (reuse || attempts > 0)
    if (!ready && attempts < MAX_STYLE_WAIT_FRAMES) {
      attempts += 1
      pendingOpens.set(element, requestAnimationFrame(open))
      return
    }
    element.style.visibility = ''
    element.style.transition = ''
    void getComputedStyle(element).opacity
    element.dataset.state = 'open'
  }
  pendingOpens.set(element, requestAnimationFrame(open))
}

/**
 * Close `element`: set `data-state="closing"`, wait out its declared close duration, then call
 * `finish`. Under reduced motion or a zero duration `finish` runs immediately.
 *
 * Returns a cancel function: clearing the timer and removing the closing state, so a reopen while
 * the exit is still running takes over from the current frame.
 */
export const closeSurface = (
  element: HTMLElement,
  finish: () => void,
  durationProperty?: string,
): (() => void) => {
  cancelSurfaceOpen(element)
  cancelSurfaceClose(element)
  const duration = surfaceCloseDurationMs(element, durationProperty)
  if (duration <= 0 || prefersReducedMotion()) {
    element.removeAttribute('data-state')
    finish()
    return () => {}
  }
  element.dataset.state = 'closing'
  const timer = window.setTimeout(() => {
    pendingCloses.delete(element)
    element.removeAttribute('data-state')
    finish()
  }, duration)
  pendingCloses.set(element, timer)
  return () => cancelSurfaceClose(element)
}
