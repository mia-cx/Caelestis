import type { ServerAssetContentType } from '@caelestis/shared'

/**
 * An operator's public server details and branding, or nulls where they have not set an override.
 *
 * Null falls back to deployment configuration for name and description; branding fields are
 * omitted from public responses when null.
 */
export interface ServerSettings {
  readonly name: string | null
  readonly description: string | null
  readonly discordInviteUrl: string | null
  readonly homeCopy: string | null
  readonly logoText: string | null
  readonly logo: ServerAssetRecord | null
  readonly preview: ServerAssetRecord | null
}

/** Branding object key relative to the branding namespace, plus its sniffed media type. */
export interface ServerAssetRecord {
  readonly blobKey: string
  readonly contentType: ServerAssetContentType
}

/** The fields an operator changes; absent leaves a field alone, explicit null clears it. */
export interface ServerSettingsPatch {
  readonly name?: string
  readonly description?: string | null
  readonly discordInviteUrl?: string | null
  readonly homeCopy?: string | null
  readonly logoText?: string | null
  readonly logo?: ServerAssetRecord | null
  readonly preview?: ServerAssetRecord | null
}

export interface ServerSettingsStore {
  /** The operator's overrides. Nulls throughout when nobody has set anything. */
  readServerSettings(): Promise<ServerSettings>

  writeServerSettings(patch: ServerSettingsPatch): Promise<void>
}
