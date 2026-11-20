import {
  keyBindingFromStroke,
  keyBindingMatches,
  resolveShortcutBindings,
  SHORTCUT_IDS,
  SHORTCUTS,
  type ShortcutBindings,
  type ShortcutId,
  type ShortcutOverrides,
  type ShortcutPlatform,
  shortcutLabel,
} from '@caelestis/shared'
import { getState } from './settings.js'
import { typingInTextField } from './wplace-dom.js'

interface ShortcutPlatformSource {
  readonly platform?: string
  readonly userAgent?: string
  readonly userAgentData?: { readonly platform?: string }
}

/** Resolve the keyboard convention without relying on the character produced by a key. */
export const currentShortcutPlatform = (): ShortcutPlatform => {
  if (typeof navigator === 'undefined') return 'windows-linux'
  const source: ShortcutPlatformSource = navigator
  const platform = source.userAgentData?.platform || source.platform || source.userAgent || ''
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'mac' : 'windows-linux'
}

let resolvedFor: ShortcutOverrides | undefined
let resolved: ShortcutBindings = resolveShortcutBindings()

/** The chords in force right now: the user's overrides over the defaults. */
export const activeShortcutBindings = (): ShortcutBindings => {
  const overrides = getState().shortcutOverrides
  if (overrides !== resolvedFor) {
    resolvedFor = overrides
    resolved = resolveShortcutBindings(overrides)
  }
  return resolved
}

/**
 * The key hint a tooltip appends to an action's name: ` (C)`, or nothing once the action has no
 * key, so a rebound control never advertises a chord that does nothing.
 */
export const shortcutHint = (
  id: ShortcutId,
  platform: ShortcutPlatform = currentShortcutPlatform(),
): string => {
  const label = shortcutLabel(activeShortcutBindings()[id], platform)
  return label === '' ? '' : ` (${label})`
}

/**
 * Resolve a non-typing keydown to one of Caelestis's deliberately few shortcuts.
 *
 * Actions are tried in a fixed order and the first match wins, so a chord can never fire two of
 * them even if stored bindings somehow overlap.
 */
export const shortcutFor = (
  event: KeyboardEvent,
  platform: ShortcutPlatform,
): ShortcutId | null => {
  if (typingInTextField(event)) return null
  const pressed = keyBindingFromStroke(event, platform)
  if (pressed === null) return null
  const bindings = activeShortcutBindings()
  // A recorded physical key outranks a default character: after a layout change the same physical
  // key can start reporting a default's character, and the user's own choice must keep winning.
  for (const physical of [true, false]) {
    for (const id of SHORTCUT_IDS) {
      const matched = bindings[id].some(
        (binding) => (binding.code !== '') === physical && keyBindingMatches(binding, pressed),
      )
      if (!matched) continue
      // Repeats are intentional for undo and redo: holding the chord walks Wplace's per-pixel
      // history. Every other shortcut remains single-shot.
      if (event.repeat === true && SHORTCUTS[id].repeats !== true) return null
      return id
    }
  }
  return null
}
