import { eq, sql } from 'drizzle-orm'
import { RelationalStore } from '../adapters/relational-store.js'
import { serverSettings } from '../db/schema.js'
import type { ServerSettings, ServerSettingsPatch, ServerSettingsStore } from './store.js'

export class RelationalServerSettingsStore extends RelationalStore implements ServerSettingsStore {
  async readServerSettings(): Promise<ServerSettings> {
    const rows = await this.database
      .select()
      .from(serverSettings)
      .where(eq(serverSettings.id, 1))
      .limit(1)
    const row = rows[0]
    return {
      name: row?.name ?? null,
      description: row?.description ?? null,
      discordInviteUrl: row?.discordInviteUrl ?? null,
      homeCopy: row?.homeCopy ?? null,
      logoText: row?.logoText ?? null,
      logo:
        row?.logoBlobKey && row.logoContentType
          ? { blobKey: row.logoBlobKey, contentType: row.logoContentType }
          : null,
      preview:
        row?.previewBlobKey && row.previewContentType
          ? { blobKey: row.previewBlobKey, contentType: row.previewContentType }
          : null,
    }
  }

  async writeServerSettings(patch: ServerSettingsPatch): Promise<void> {
    const next = {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.discordInviteUrl === undefined ? {} : { discordInviteUrl: patch.discordInviteUrl }),
      ...(patch.homeCopy === undefined ? {} : { homeCopy: patch.homeCopy }),
      ...(patch.logoText === undefined ? {} : { logoText: patch.logoText }),
      ...(patch.logo === undefined
        ? {}
        : {
            logoBlobKey: patch.logo?.blobKey ?? null,
            logoContentType: patch.logo?.contentType ?? null,
          }),
      ...(patch.preview === undefined
        ? {}
        : {
            previewBlobKey: patch.preview?.blobKey ?? null,
            previewContentType: patch.preview?.contentType ?? null,
          }),
    }
    if (Object.keys(next).length === 0) return
    await this.database
      .insert(serverSettings)
      .values({
        id: 1,
        ...next,
      })
      .onConflictDoUpdate({
        target: [serverSettings.id].map((column) => sql`${sql.identifier(column.name)}`),
        set: next,
      })
  }
}
