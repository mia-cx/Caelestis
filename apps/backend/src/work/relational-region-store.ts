import {
  isRegionDocument,
  isRegionShape,
  REGION_CLAIM_TTL_MS,
  type RegionClaim,
  type RegionDocument,
  regionDocumentBounds,
  type TemplateSurface,
  templateSurface,
} from '@caelestis/shared'
import { and, asc, eq, gt, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { changedRows, relationalDatabase } from '../adapters/relational-database.js'
import type { SqlConnection } from '../adapters/sql-connection.js'
import { workRegionDeletions, workRegions } from '../db/schema.js'
import type { RegionOwner, RegionStore, RegionWriter } from './region-store.js'

const ownedBy = (writer: RegionWriter) =>
  writer.admin
    ? undefined
    : and(
        eq(workRegions.claimantUserId, writer.actorId),
        or(isNull(workRegions.tokenHash), eq(workRegions.tokenHash, writer.tokenHash)),
      )

const fromRow = (row: typeof workRegions.$inferSelect): RegionClaim => {
  const surface = templateSurface(row.surfaceKind, row.allianceId)
  if (surface === null) throw new Error('Invalid stored region surface')
  const rect = { x: row.x, y: row.y, w: row.w, h: row.h }
  let shape: unknown = null
  if (row.shape !== null) {
    try {
      shape = JSON.parse(row.shape)
    } catch {
      // Malformed document data falls back to the stored rectangle.
    }
  }
  return {
    id: row.id,
    season: row.season,
    surface,
    templateId: row.templateId,
    claimant: { wplaceUserId: row.claimantUserId, displayName: row.claimantName },
    document: isRegionDocument(shape)
      ? shape
      : {
          items: [
            {
              id: 'legacy',
              shape: isRegionShape(shape) ? shape : { kind: 'rectangle', ...rect },
              op: 'add',
            },
          ],
        },
    rect,
    label: row.label,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt ?? row.createdAt + REGION_CLAIM_TTL_MS,
  }
}

/** Enforce ID uniqueness in the insert statement itself; there is no cap on claims per surface. */
export class RelationalRegionStore implements RegionStore {
  private readonly db
  constructor(private readonly client: SqlConnection) {
    this.db = relationalDatabase(client)
  }

  async expireRegions(now: number): Promise<void> {
    // Older binaries can still insert without expiry between migration and replacement.
    await this.db
      .update(workRegions)
      .set({ expiresAt: sql`${workRegions.createdAt} + ${REGION_CLAIM_TTL_MS}` })
      .where(isNull(workRegions.expiresAt))
      .run()
    // Expiry drops this server's replica; another server may still renew the logical claim.
    // Explicit deletion keeps its primary key forever, including after its former expiry.
    await this.db
      .delete(workRegions)
      .where(and(ne(workRegions.state, 'deleted'), lte(workRegions.expiresAt, now)))
      .run()
  }

  async regionOwners(season: number, surface: TemplateSurface): Promise<readonly RegionOwner[]> {
    const rows = await this.db
      .select({
        id: workRegions.id,
        tokenHash: workRegions.tokenHash,
        actorId: workRegions.claimantUserId,
      })
      .from(workRegions)
      .where(
        and(
          eq(workRegions.season, season),
          eq(workRegions.surfaceKind, surface.kind),
          surface.allianceId === null
            ? isNull(workRegions.allianceId)
            : eq(workRegions.allianceId, surface.allianceId),
          isNotNull(workRegions.tokenHash),
          eq(workRegions.state, 'active'),
        ),
      )
    return rows.flatMap((row) =>
      row.tokenHash === null ? [] : [{ ...row, tokenHash: row.tokenHash }],
    )
  }

  async renewRegions(tokenHash: string, actorId: number, now: number): Promise<boolean> {
    await this.expireRegions(now)
    const result = await this.db
      .update(workRegions)
      .set({ expiresAt: now + REGION_CLAIM_TTL_MS })
      .where(
        and(
          eq(workRegions.tokenHash, tokenHash),
          eq(workRegions.claimantUserId, actorId),
          gt(workRegions.expiresAt, now),
          eq(workRegions.state, 'active'),
        ),
      )
      .run()
    return changedRows(result) > 0
  }

  async listRegions(
    season: number,
    surface: TemplateSurface,
    templateId?: string,
  ): Promise<readonly RegionClaim[]> {
    await this.expireRegions(Date.now())
    const rows = await this.db
      .select()
      .from(workRegions)
      .where(
        and(
          eq(workRegions.season, season),
          eq(workRegions.surfaceKind, surface.kind),
          surface.allianceId === null
            ? isNull(workRegions.allianceId)
            : eq(workRegions.allianceId, surface.allianceId),
          templateId === undefined ? undefined : eq(workRegions.templateId, templateId),
          eq(workRegions.state, 'active'),
        ),
      )
      .orderBy(asc(workRegions.createdAt), asc(workRegions.id))
    return rows.map(fromRow)
  }

  async readRegion(id: string): Promise<RegionClaim | null> {
    await this.expireRegions(Date.now())
    const [row] = await this.db
      .select()
      .from(workRegions)
      .where(and(eq(workRegions.id, id), ne(workRegions.state, 'deleted')))
      .limit(1)
    return row === undefined ? null : fromRow(row)
  }

  async isRegionDeleted(id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: workRegionDeletions.id })
      .from(workRegionDeletions)
      .where(eq(workRegionDeletions.id, id))
      .limit(1)
    return row !== undefined
  }

  async createRegion(region: RegionClaim, tokenHash: string | null): Promise<boolean> {
    await this.expireRegions(Date.now())
    const { surface, document, claimant } = region
    const rect = regionDocumentBounds(document)
    if (rect === null) throw new Error('Region document must contain an added shape')
    const result = await this.client
      .prepare(`INSERT INTO work_regions
      (id, season, surface_kind, alliance_id, template_id, claimant_user_id, claimant_name, x, y, w, h, label, created_at, shape, token_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`)
      .bind(
        region.id,
        region.season,
        surface.kind,
        surface.allianceId,
        region.templateId ?? null,
        claimant.wplaceUserId,
        claimant.displayName,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        region.label,
        region.createdAt,
        JSON.stringify(document),
        tokenHash,
        region.expiresAt ?? Date.now() + REGION_CLAIM_TTL_MS,
      )
      .run()
      .catch(async (error: unknown) => {
        // MariaDB rejects a retired ID through its NOT NULL insert guard. SQLite/Postgres skip it.
        if (await this.isRegionDeleted(region.id)) return { meta: { changes: 0 } }
        throw error
      })
    return result.meta.changes === 1
  }

  async deleteRegion(id: string, writer: RegionWriter, withdraw = false): Promise<boolean> {
    if (!withdraw) {
      const canClear = writer.admin ? undefined : eq(workRegions.claimantUserId, writer.actorId)
      // Retire the ID and remove the live row atomically. Old binaries cannot see the tombstone
      // or erase it with their expiry sweep, and the database blocks their stale reinsertion.
      const retire = this.db
        .insert(workRegionDeletions)
        .select(
          this.db
            .select({ id: workRegions.id })
            .from(workRegions)
            .where(and(eq(workRegions.id, id), canClear)),
        )
        .onConflictDoNothing()
      const remove = this.db.delete(workRegions).where(and(eq(workRegions.id, id), canClear))
      const [, result] = await this.db.batch([retire, remove])
      return changedRows(result) === 1
    }
    const result = await this.db
      .update(workRegions)
      .set({ state: 'withdrawn' })
      .where(and(eq(workRegions.id, id), ownedBy(writer), ne(workRegions.state, 'deleted')))
      .run()
    return changedRows(result) === 1
  }

  async updateRegion(
    id: string,
    document: RegionDocument,
    label: string,
    templateId: string | null,
    writer: RegionWriter,
  ): Promise<RegionClaim | null> {
    const rect = regionDocumentBounds(document)
    if (rect === null) throw new Error('Region document must contain an added shape')
    await this.expireRegions(Date.now())
    const update = this.db
      .update(workRegions)
      .set({
        shape: JSON.stringify(document),
        ...rect,
        label,
        templateId,
        tokenHash: sql`coalesce(${workRegions.tokenHash}, ${writer.tokenHash})`,
        state: 'active',
      })
      .where(and(eq(workRegions.id, id), ownedBy(writer), ne(workRegions.state, 'deleted')))
    if (this.client.dialect === 'mariadb') {
      const [, read] = await this.db.batch([
        update,
        this.db
          .select()
          .from(workRegions)
          .where(and(eq(workRegions.id, id), ownedBy(writer), eq(workRegions.state, 'active')))
          .limit(1),
      ])
      return read[0] === undefined ? null : fromRow(read[0])
    }
    const [row] = await update.returning()
    return row === undefined ? null : fromRow(row)
  }
}
