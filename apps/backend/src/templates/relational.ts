import {
  type Millis,
  parseTemplateRecipe,
  type TemplateRecipe,
  templateRecipeJson,
} from '@caelestis/shared'
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { violates } from '../adapters/constraint-violation.js'
import { changedRows } from '../adapters/relational-database.js'
import { chunkRows, parseColourTotals, RelationalStore } from '../adapters/relational-store.js'
import {
  IDS_PER_STATEMENT,
  MAX_IDS_PER_READ,
  tooManyIds,
  VERSION_TILE_ROWS_PER_INSERT,
} from '../db/d1-limits.js'
import { contributions, templates, templateVersions, versionTiles } from '../db/schema.js'
import { scopeWhere, surfaceOf } from '../db/scope.js'
import { selectNode } from '../nodes/relational.js'
import { assertSameScope, NodeNotFoundError } from '../nodes/store.js'
import {
  assertSameTemplate,
  assertValidTemplateVersion,
  type ManifestTemplateRecord,
  type ManifestTileRecord,
  type TemplateDeletePrecondition,
  type TemplateManifestScope,
  TemplateNotFoundError,
  type TemplatePatch,
  type TemplateRecord,
  type TemplateStore,
  type TemplateVersionRecord,
} from './store.js'

const parseStoredRecipe = (versionId: string, value: string | null): TemplateRecipe | undefined => {
  if (value === null) return undefined
  const recipe = parseTemplateRecipe(JSON.parse(value))
  if (recipe === null) throw new Error(`template version ${versionId} has an invalid recipe`)
  return recipe
}

export class RelationalTemplateStore extends RelationalStore implements TemplateStore {
  async createTemplate(version: TemplateVersionRecord): Promise<void> {
    assertValidTemplateVersion(version)
    if (version.nodeId !== null) {
      const destination = await selectNode(this.database, version.nodeId)
      if (destination === null) {
        throw new NodeNotFoundError(`node does not exist: ${version.nodeId}`)
      }
      assertSameScope(destination, version, 'destination node')
    }
    const template = this.database.insert(templates).values({
      id: version.templateId,
      season: version.season,
      surfaceKind: version.surface.kind,
      allianceId: version.surface.allianceId,
      nodeId: version.nodeId,
      name: version.name,
      currentVersionId: null,
      publishedAt: null,
      createdWithToken: version.createdWithToken,
      createdByUserId: version.createdByUserId,
      createdAtMs: version.createdAt,
      updatedAtMs: version.createdAt,
    })
    try {
      await this.database.batch([template, ...this.#versionStatements(version)])
    } catch (error) {
      // The node check above is a separate read, so a concurrent delete can remove the node between
      // the two and the foreign key rejects this insert. Same outcome as the check finding it
      // missing, so it gets the same error rather than escaping as a 500.
      if (violates(error, 'foreign-key')) {
        throw new NodeNotFoundError(`node does not exist: ${version.nodeId}`)
      }
      throw error
    }
  }

  async addTemplateVersion(version: TemplateVersionRecord): Promise<void> {
    assertValidTemplateVersion(version)
    // A version replaces content in place, so it has to keep the same surface and dimensions. Name
    // and parent are live template metadata and may legitimately change while pixels are encoded.
    const [existing] = await this.database
      .select({
        surfaceKind: templates.surfaceKind,
        allianceId: templates.allianceId,
        minX: templateVersions.minX,
        minY: templateVersions.minY,
        maxX: templateVersions.maxX,
        maxY: templateVersions.maxY,
      })
      .from(templates)
      .leftJoin(templateVersions, eq(templateVersions.id, templates.currentVersionId))
      .where(eq(templates.id, version.templateId))
      .limit(1)
    if (existing !== undefined) {
      const { minX, minY, maxX, maxY } = existing
      assertSameTemplate(
        version.templateId,
        {
          surface: surfaceOf(existing, `template ${version.templateId}`),
          bbox:
            minX === null || minY === null || maxX === null || maxY === null
              ? null
              : { minX, minY, maxX, maxY },
        },
        version,
      )
    }
    try {
      await this.database.batch(this.#versionStatements(version))
    } catch (error) {
      // The template can be deleted between the read above and this batch.
      if (violates(error, 'foreign-key')) {
        throw new TemplateNotFoundError(`template does not exist: ${version.templateId}`)
      }
      throw error
    }
  }

  /** The version row, its tile index, and the pointer that makes it current, in batch order. */
  #versionStatements(version: TemplateVersionRecord) {
    return [
      this.database.insert(templateVersions).values({
        id: version.versionId,
        templateId: version.templateId,
        createdAtMs: version.createdAt,
        createdWithToken: version.createdWithToken,
        createdByUserId: version.createdByUserId,
        minX: version.bbox.minX,
        minY: version.bbox.minY,
        maxX: version.bbox.maxX,
        maxY: version.bbox.maxY,
        totalPixels: version.totalPixels,
        colourTotalsJson:
          version.colourTotals === undefined ? null : JSON.stringify(version.colourTotals),
        sourceHash: version.recipe?.source.sha256 ?? null,
        recipeJson: version.recipe === undefined ? null : templateRecipeJson(version.recipe),
      }),
      // Tiles go in as multi-row inserts, not one statement each: D1 allows 50 queries per Worker
      // invocation on the free plan, which a 48-chunk template (a 48,000x1 upload) would exceed.
      // Chunked by bound parameters: four columns each, kept under the 100-parameter ceiling.
      ...chunkRows(
        version.chunks.map((chunk) => ({
          versionId: version.versionId,
          tileX: chunk.tileX,
          tileY: chunk.tileY,
          hash: chunk.hash,
        })),
        VERSION_TILE_ROWS_PER_INSERT,
      ).map((rows) => this.database.insert(versionTiles).values(rows)),
      // The referenced version exists before this statement runs. D1 executes batch statements in
      // order, so the circular template/version relationship never needs deferred foreign keys.
      // New pixels are a change like any other, so the template's own timestamp moves with them —
      // for a template that already existed, this is the only column besides the version that does.
      this.database
        .update(templates)
        .set({ currentVersionId: version.versionId, updatedAtMs: version.createdAt })
        .where(eq(templates.id, version.templateId)),
    ] as const
  }

  async listTemplateVersions(templateId: string) {
    return this.database
      .select({ versionId: templateVersions.id, createdAt: templateVersions.createdAtMs })
      .from(templateVersions)
      .where(eq(templateVersions.templateId, templateId))
      .orderBy(asc(templateVersions.createdAtMs), asc(templateVersions.id))
  }

  async isPublishedArtwork(namespace: 'chunks' | 'sources', hash: string) {
    const published = isNotNull(templates.publishedAt)
    const versions = this.database
      .select({ found: sql<number>`1` })
      .from(templateVersions)
      .innerJoin(templates, eq(templates.id, templateVersions.templateId))
    const rows =
      namespace === 'chunks'
        ? await versions
            .innerJoin(versionTiles, eq(versionTiles.versionId, templateVersions.id))
            .where(and(eq(versionTiles.hash, hash), published))
            .limit(1)
        : await versions.where(and(eq(templateVersions.sourceHash, hash), published)).limit(1)
    return rows.length > 0
  }

  async readTemplateVersion(versionId: string): Promise<TemplateVersionRecord | null> {
    const rows = await this.database
      .select({
        templateId: templates.id,
        surfaceKind: templates.surfaceKind,
        allianceId: templates.allianceId,
        season: templates.season,
        nodeId: templates.nodeId,
        name: templates.name,
        versionId: templateVersions.id,
        createdWithToken: templateVersions.createdWithToken,
        createdByUserId: templateVersions.createdByUserId,
        createdAt: templateVersions.createdAtMs,
        minX: templateVersions.minX,
        minY: templateVersions.minY,
        maxX: templateVersions.maxX,
        maxY: templateVersions.maxY,
        totalPixels: templateVersions.totalPixels,
        colourTotalsJson: templateVersions.colourTotalsJson,
        recipeJson: templateVersions.recipeJson,
      })
      .from(templateVersions)
      .innerJoin(templates, eq(templates.id, templateVersions.templateId))
      .where(eq(templateVersions.id, versionId))
      .limit(1)
    const row = rows[0]
    if (row === undefined) return null
    const surface = surfaceOf(row, `template ${row.templateId}`)
    const colourTotals = parseColourTotals(row.colourTotalsJson)
    const recipe = parseStoredRecipe(row.versionId, row.recipeJson)

    const chunks = await this.database
      .select({ tileX: versionTiles.tileX, tileY: versionTiles.tileY, hash: versionTiles.hash })
      .from(versionTiles)
      .where(eq(versionTiles.versionId, versionId))
      .orderBy(asc(versionTiles.tileY), asc(versionTiles.tileX))

    return {
      templateId: row.templateId,
      surface,
      season: row.season,
      nodeId: row.nodeId,
      name: row.name,
      versionId: row.versionId,
      createdByUserId: row.createdByUserId,
      createdWithToken: row.createdWithToken,
      createdAt: row.createdAt,
      bbox: { minX: row.minX, minY: row.minY, maxX: row.maxX, maxY: row.maxY },
      totalPixels: row.totalPixels,
      ...(colourTotals === undefined ? {} : { colourTotals }),
      chunks,
      ...(recipe === undefined ? {} : { recipe }),
    }
  }

  async readTemplate(templateId: string): Promise<TemplateRecord | null> {
    const rows = await this.database
      .select({
        id: templates.id,
        season: templates.season,
        surfaceKind: templates.surfaceKind,
        allianceId: templates.allianceId,
        nodeId: templates.nodeId,
        name: templates.name,
        currentVersionId: templates.currentVersionId,
        publishedAt: templates.publishedAt,
        timelapseFrozenAt: templates.timelapseFrozenAt,
        finishedAt: templates.finishedAt,
        createdAt: templates.createdAtMs,
        updatedAt: templates.updatedAtMs,
      })
      .from(templates)
      .where(eq(templates.id, templateId))
      .limit(1)
    const row = rows[0]
    if (row === undefined) return null
    return {
      id: row.id,
      surface: surfaceOf(row, `template ${row.id}`),
      season: row.season,
      nodeId: row.nodeId,
      name: row.name,
      currentVersionId: row.currentVersionId,
      published: row.publishedAt !== null,
      timelapseFrozen: row.timelapseFrozenAt !== null,
      timelapseFrozenAt: row.timelapseFrozenAt,
      finished: row.finishedAt !== null,
      finishedAt: row.finishedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  async updateTemplate(
    templateId: string,
    patch: TemplatePatch,
    updatedAt: Millis,
  ): Promise<boolean> {
    let predicate = eq(templates.id, templateId)
    if (patch.nodeId !== undefined) {
      const [existing] = await this.database
        .select({
          nodeId: templates.nodeId,
          season: templates.season,
          surfaceKind: templates.surfaceKind,
          allianceId: templates.allianceId,
        })
        .from(templates)
        .where(eq(templates.id, templateId))
        .limit(1)
      if (existing === undefined) return false
      if (patch.nodeId !== null) {
        const target = await selectNode(this.database, patch.nodeId)
        if (target === null) throw new NodeNotFoundError(`node does not exist: ${patch.nodeId}`)
        assertSameScope(
          target,
          { season: existing.season, surface: surfaceOf(existing, `template ${templateId}`) },
          'destination node',
        )
      }
      // If another administrator moves or deletes the template after the season check, this write
      // loses instead of applying a stale decision and reporting success.
      const parentUnchanged =
        existing.nodeId === null ? isNull(templates.nodeId) : eq(templates.nodeId, existing.nodeId)
      predicate = and(eq(templates.id, templateId), parentUnchanged) ?? predicate
    }
    if (patch.timelapseFrozenAt === null && patch.finishedAt !== null) {
      predicate = and(predicate, isNull(templates.finishedAt)) ?? predicate
    }

    try {
      const result = await this.database
        .update(templates)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.nodeId === undefined ? {} : { nodeId: patch.nodeId }),
          ...(patch.publishedAt === undefined ? {} : { publishedAt: patch.publishedAt }),
          ...(patch.timelapseFrozenAt === undefined
            ? {}
            : { timelapseFrozenAt: patch.timelapseFrozenAt }),
          ...(patch.finishedAt === undefined ? {} : { finishedAt: patch.finishedAt }),
          updatedAtMs: updatedAt,
        })
        .where(predicate)
      return changedRows(result) > 0
    } catch (error) {
      // The destination was read above, and another administrator can delete it between that read
      // and this write. Translated like the other races in this file, so it answers a typed error
      // rather than a 500.
      if (violates(error, 'foreign-key')) {
        throw new NodeNotFoundError(`node does not exist: ${patch.nodeId ?? ''}`)
      }
      throw error
    }
  }

  async deleteTemplate(templateId: string, expected: TemplateDeletePrecondition): Promise<boolean> {
    // Order matters and the batch is what makes it safe. `templates.current_version_id` points at a
    // version and every version points back at the template, so the pointer has to be dropped before
    // the rows it refers to. Tiles go first because they reference a version.
    const claimedTemplate = and(eq(templates.id, templateId), isNull(templates.currentVersionId))
    const claimedTemplateIds = this.database
      .select({ id: templates.id })
      .from(templates)
      .where(claimedTemplate)
    const claimedVersionIds = this.database
      .select({ id: templateVersions.id })
      .from(templateVersions)
      .where(
        and(
          eq(templateVersions.templateId, templateId),
          inArray(templateVersions.templateId, claimedTemplateIds),
        ),
      )
    const statements = [
      this.database
        .update(templates)
        .set({ currentVersionId: null })
        .where(
          and(
            eq(templates.id, templateId),
            eq(templates.currentVersionId, expected.versionId),
            eq(templates.updatedAtMs, expected.updatedAt),
          ),
        ),
      this.database.delete(versionTiles).where(inArray(versionTiles.versionId, claimedVersionIds)),
      this.database.delete(templateVersions).where(inArray(templateVersions.id, claimedVersionIds)),
      this.database
        .delete(contributions)
        .where(inArray(contributions.templateId, claimedTemplateIds)),
      this.database.delete(templates).where(claimedTemplate),
    ]
    const results = await this.database.batch(
      statements as [(typeof statements)[number], ...Array<(typeof statements)[number]>],
    )
    // Chunk blobs stay: they are content-addressed and shared. See `deleteTemplate` on the port.
    return changedRows(results.at(-1)) > 0
  }

  async listManifestTemplates(
    scope: TemplateManifestScope,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTemplateRecord[]> {
    const scoped = scopeWhere(templates, scope.season, scope.surface)
    const rows = await this.database
      .select({
        id: templates.id,
        nodeId: templates.nodeId,
        name: templates.name,
        versionId: templateVersions.id,
        minX: templateVersions.minX,
        minY: templateVersions.minY,
        maxX: templateVersions.maxX,
        maxY: templateVersions.maxY,
        totalPixels: templateVersions.totalPixels,
        publishedAt: templates.publishedAt,
        finishedAt: templates.finishedAt,
        timelapseFrozenAt: templates.timelapseFrozenAt,
        createdAt: templates.createdAtMs,
        updatedAt: templates.updatedAtMs,
      })
      .from(templates)
      .innerJoin(templateVersions, eq(templateVersions.id, templates.currentVersionId))
      .where(includeUnpublished ? scoped : and(scoped, isNotNull(templates.publishedAt)))

    return rows.map((row) => ({
      id: row.id,
      nodeId: row.nodeId,
      name: row.name,
      versionId: row.versionId,
      bbox: { minX: row.minX, minY: row.minY, maxX: row.maxX, maxY: row.maxY },
      totalPixels: row.totalPixels,
      published: row.publishedAt !== null,
      finished: row.finishedAt !== null,
      finishedAt: row.finishedAt,
      timelapseFrozen: row.timelapseFrozenAt !== null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
  }

  async listManifestTiles(
    scope: TemplateManifestScope,
    includeUnpublished: boolean,
  ): Promise<readonly ManifestTileRecord[]> {
    const scoped = scopeWhere(templates, scope.season, scope.surface)
    return this.database
      .select({
        templateId: templates.id,
        versionId: templateVersions.id,
        tileX: versionTiles.tileX,
        tileY: versionTiles.tileY,
        hash: versionTiles.hash,
      })
      .from(versionTiles)
      .innerJoin(templateVersions, eq(templateVersions.id, versionTiles.versionId))
      .innerJoin(
        templates,
        and(
          eq(templates.id, templateVersions.templateId),
          eq(templates.currentVersionId, templateVersions.id),
        ),
      )
      .where(includeUnpublished ? scoped : and(scoped, isNotNull(templates.publishedAt)))
  }

  async filterPublishedTemplateIds(ids: readonly string[]): Promise<readonly string[]> {
    const distinct = [...new Set(ids)]
    if (distinct.length > MAX_IDS_PER_READ) {
      throw tooManyIds(distinct.length, 'filterPublishedTemplateIds')
    }
    // Chunked like `readBuckets` for the same bound-parameter budget; membership is per-id, so
    // concatenating chunk results loses nothing.
    const published = new Set<string>()
    for (let offset = 0; offset < distinct.length; offset += IDS_PER_STATEMENT) {
      const chunk = distinct.slice(offset, offset + IDS_PER_STATEMENT)
      const rows = await this.database
        .select({ id: templates.id })
        .from(templates)
        .where(and(inArray(templates.id, chunk), isNotNull(templates.publishedAt)))
      for (const row of rows) published.add(row.id)
    }
    return distinct.filter((id) => published.has(id))
  }
}
