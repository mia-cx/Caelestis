import type { Scope } from '@caelestis/shared'
import type { ShortcutHelpPlatform } from '../shortcut-help/model.js'

export type SettingsBooleanKey =
  | 'reportPaints'
  | 'shareTiles'
  | 'sharePresence'
  | 'showPresence'
  | 'showPresenceViewports'
  | 'showPresenceClaims'
  | 'showPresenceClaimsOnlyWhilePainting'
  | 'debugLogging'
  | 'performanceProfiling'
  | 'notifyRegressions'
  | 'notifyGriefing'
  | 'notifyUpdates'
  | 'notifyActivity'

export type AccessTokenScope = Scope

export interface SettingsAccessTokenModel {
  readonly tokenHash: string
  readonly label: string
  readonly scope: AccessTokenScope
  readonly createdAt: number
  readonly bootstrap: boolean
  readonly pending?: boolean
}

export interface SettingsAccessTokensModel {
  readonly status: 'loading' | 'ready' | 'error'
  readonly tokens: readonly SettingsAccessTokenModel[]
  readonly hasMore: boolean
  /** The server says it mints event-runner invites, so the scope picker offers them. */
  readonly eventRunners?: true
  readonly loadingMore?: boolean
  readonly creating?: boolean
  readonly createError?: string
  readonly created: number
}

export interface SettingsServerModel {
  readonly url: string
  readonly name: string
  readonly status: 'connected' | 'needs-token' | 'unreachable'
  readonly error?: string
  readonly expanded: boolean
  readonly tokenSaved: boolean
  readonly tokenUsable?: boolean
  readonly isAdmin: boolean
  readonly pending?: boolean
  readonly message?: string
  /** Release text the server reported, e.g. `0.9.0 · a1b2c3d4e5f6`. */
  readonly version?: string
  /** Present when the server reports a backend version older than this userscript expects. */
  readonly outdated?: { readonly expected: string }
  readonly accessTokens?: SettingsAccessTokensModel
}

export interface ProfileMetricModel {
  readonly id: string
  readonly label: string
  readonly value: string
}

/** One of the host's fixes to Wplace's own client, which a painter can switch off. */
export interface SettingsWplacePatchModel {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly enabled: boolean
}

/**
 * The settings that apply to every Wplace tab, shown both in the panel's Settings view and in the
 * extension's toolbar popup.
 */
export interface GlobalSettingsModel {
  readonly reportPaints: boolean
  readonly shareTiles: boolean
  readonly sharePresence: boolean
  readonly showPresence: boolean
  readonly showPresenceViewports: boolean
  readonly showPresenceClaims: boolean
  readonly showPresenceClaimsOnlyWhilePainting: boolean
  readonly debugLogging: boolean
  readonly performanceProfiling: boolean
  readonly notifyRegressions: boolean
  readonly notifyGriefing: boolean
  /** Absent in the extension, whose store updates it, so the row is not shown. */
  readonly notifyUpdates?: boolean | undefined
  readonly notifyActivity: boolean
  readonly wplacePatches?: readonly SettingsWplacePatchModel[]
  /** Features allowed to simulate input on Wplace's controls. */
  readonly simulatedInput: import('@caelestis/shared').SimulatedInputSwitches
  /** The keys in force, which the Dangerous settings hints name. */
  readonly shortcuts: {
    readonly platform: ShortcutHelpPlatform
    readonly bindings: import('@caelestis/shared').ShortcutBindings
  }
  /** Caelestis's switches in Wplace's own Accessibility settings; the popup shows them too. */
  readonly accessibility?: {
    readonly falseType: boolean
    readonly cursors: boolean
  }
}

export type AccessibilitySettingKey = keyof NonNullable<GlobalSettingsModel['accessibility']>

export type GlobalSettingsIntent =
  | { readonly type: 'set-boolean'; readonly key: SettingsBooleanKey; readonly value: boolean }
  | { readonly type: 'set-wplace-patch'; readonly id: string; readonly enabled: boolean }
  | {
      readonly type: 'set-accessibility'
      readonly key: AccessibilitySettingKey
      readonly value: boolean
    }
  | {
      readonly type: 'set-simulated-input'
      readonly id: import('@caelestis/shared').SimulatedInput
      readonly value: boolean
    }

/** The extension's toolbar popup. */
export interface ExtensionSettingsModel extends GlobalSettingsModel {
  readonly version: string
}

export interface SettingsModel extends GlobalSettingsModel {
  /** Installed Caelestis version shown in the settings header, e.g. `0.15.0`. */
  readonly userscriptVersion?: string
  /** Which build that version belongs to; the userscript when absent. */
  readonly build?: 'userscript' | 'extension'
  /** The other build, while it is installed too, to import settings from or send them to. */
  readonly otherBuild?: 'userscript' | 'extension' | undefined
  readonly servers: readonly SettingsServerModel[]
  readonly addServerPending?: boolean
  readonly addServerMessage?: string
  readonly colourNavigationOrder: 'unpainted-first' | 'mismatched-first'
  readonly shortcuts: ShortcutSettingsModel
  readonly profile?: {
    readonly note: string
    readonly metrics: readonly ProfileMetricModel[]
    readonly status?: string
  }
}

export type SettingsIntent =
  | { readonly type: 'add-server'; readonly url: string }
  | { readonly type: 'toggle-server'; readonly url: string; readonly expanded: boolean }
  | { readonly type: 'prefetch-server'; readonly url: string }
  | { readonly type: 'update-server-token'; readonly url: string; readonly token: string }
  | { readonly type: 'disconnect-server'; readonly url: string }
  | { readonly type: 'load-more-access-tokens'; readonly url: string }
  | {
      readonly type: 'create-access-token'
      readonly url: string
      readonly label: string
      readonly scope: AccessTokenScope
    }
  | {
      readonly type: 'revoke-access-token'
      readonly url: string
      readonly tokenHash: string
      readonly label: string
    }
  | {
      readonly type: 'set-colour-navigation-order'
      readonly value: SettingsModel['colourNavigationOrder']
    }
  | {
      readonly type: 'set-simulated-input'
      readonly id: import('@caelestis/shared').SimulatedInput
      readonly value: boolean
    }
  | { readonly type: 'set-boolean'; readonly key: SettingsBooleanKey; readonly value: boolean }
  | { readonly type: 'set-wplace-patch'; readonly id: string; readonly enabled: boolean }
  | { readonly type: 'import-from-other-build' }
  | { readonly type: 'send-to-other-build' }
  | {
      readonly type: 'set-shortcut-binding'
      readonly id: import('@caelestis/shared').ShortcutId
      /** `null` leaves the action without a key. */
      readonly binding: import('@caelestis/shared').KeyBinding | null
    }
  | { readonly type: 'reset-shortcut-bindings' }
  | { readonly type: 'reset-profile' }
  | { readonly type: 'copy-profile' }

export interface ShortcutSettingsModel {
  readonly platform: ShortcutHelpPlatform
  readonly bindings: import('@caelestis/shared').ShortcutBindings
  /** Whether any action differs from its default, which is when reset does something. */
  readonly customised: boolean
  /** The last recorded chord and the actions it was taken from, so the panel can say so. */
  readonly lastChange?: {
    readonly id: import('@caelestis/shared').ShortcutId
    readonly displaced: readonly import('@caelestis/shared').ShortcutId[]
  }
}
