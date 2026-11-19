export type ShortcutHelpPlatform = import('@caelestis/shared').ShortcutPlatform

export interface ShortcutHelpModel {
  readonly platform: ShortcutHelpPlatform
  /** The chords in force, so the reference shows what the keys do right now. */
  readonly bindings: import('@caelestis/shared').ShortcutBindings
  /** Which actions may simulate clicks on Wplace's controls. */
  readonly simulatedInput: import('@caelestis/shared').SimulatedInputSwitches
}

export type ShortcutHelpIntent = { readonly type: 'close' }
