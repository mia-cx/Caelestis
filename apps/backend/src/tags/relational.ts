import {
  MAX_TEMPLATE_TAGS,
  type Millis,
  type TemplateSurface,
  type TemplateTag,
  tagNameKey,
  templateSurface,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { violates } from '../adapters/constraint-violation.js'
import { RelationalStore } from '../adapters/relational-store.js'
import { scopeBindings, scopeCondition } from '../db/scope.js'
import type { TemplateManifestScope } from '../templates/store.js'
import { TagConflictError, type TagMutation, type TagStore } from './store.js'

/** SQLite reports this plain unique index by its column; the portable schemas by its name. */
const TAG_NAME_UNIQUE = ['tags.name_key', 'tags_name_key_unique']

export class RelationalTagStore extends RelationalStore implements TagStore {
  async listTags(): Promise<readonly TemplateTag[]> {
    const result = await this.client
      .prepare('SELECT id, name FROM tags ORDER BY id')
      .all<TemplateTag>()
    return result.results
  }

  async listTemplateTagIds(templateId: string): Promise<readonly string[]> {
    const result = await this.client
      .prepare('SELECT tag_id AS id FROM template_tags WHERE template_id = ? ORDER BY tag_id')
      .bind(templateId)
      .all<{ id: string }>()
    return result.results.map(({ id }) => id)
  }

  async listManifestTags(scope: TemplateManifestScope, includeUnpublished: boolean) {
    const result = await this.client
      .prepare(`SELECT tt.template_id AS "templateId", tags.id, tags.name
      FROM template_tags tt JOIN tags ON tags.id = tt.tag_id JOIN templates t ON t.id = tt.template_id
      WHERE ${scopeCondition('t', this.syntax.nullEqual)} AND (? = 1 OR t.published_at IS NOT NULL)
      ORDER BY tags.id`)
      .bind(...scopeBindings(scope.season, scope.surface), includeUnpublished ? 1 : 0)
      .all<{ templateId: string; id: string; name: string }>()
    return result.results.map(({ templateId, id, name }) => ({ templateId, tag: { id, name } }))
  }

  async listNodeTagIds(nodeId: string): Promise<readonly string[]> {
    const result = await this.client
      .prepare('SELECT tag_id AS id FROM node_tags WHERE node_id = ? ORDER BY tag_id')
      .bind(nodeId)
      .all<{ id: string }>()
    return result.results.map(({ id }) => id)
  }

  async listManifestNodeTags(scope: TemplateManifestScope) {
    const result = await this.client
      .prepare(`SELECT nt.node_id AS "nodeId", tags.id, tags.name
      FROM node_tags nt JOIN tags ON tags.id = nt.tag_id JOIN nodes n ON n.id = nt.node_id
      WHERE ${scopeCondition('n', this.syntax.nullEqual)} ORDER BY tags.id`)
      .bind(...scopeBindings(scope.season, scope.surface))
      .all<{ nodeId: string; id: string; name: string }>()
    return result.results.map(({ nodeId, id, name }) => ({ nodeId, tag: { id, name } }))
  }

  async listTagScopes(): Promise<readonly TemplateManifestScope[]> {
    const result = await this.client
      .prepare(
        'SELECT season, surface_kind AS kind, alliance_id AS "allianceId" FROM templates UNION SELECT season, surface_kind AS kind, alliance_id AS "allianceId" FROM nodes',
      )
      .all<{ season: number; kind: TemplateSurface['kind']; allianceId: number | null }>()
    return result.results.map((row) => ({
      season: row.season,
      surface: templateSurface(row.kind, row.allianceId) ?? WORLD_TEMPLATE_SURFACE,
    }))
  }

  async mutateTag(mutation: TagMutation, now: Millis): Promise<boolean> {
    const prepare = (query: string, ...values: (string | number | null)[]) =>
      this.client.prepare(query).bind(...values)
    // A tag change alters the manifest, so it moves each affected template's revision forward.
    const bumpRevisions = `UPDATE templates SET updated_at_ms = ${this.syntax.greatest}(updated_at_ms + 1, ?) WHERE`
    try {
      if (mutation.type === 'assign-folder') {
        const guard =
          'EXISTS (SELECT 1 FROM tags WHERE id = ?) AND EXISTS (SELECT 1 FROM nodes WHERE id = ?)'
        const write = mutation.attached
          ? prepare(
              `INSERT INTO node_tags (tag_id, node_id) SELECT ?, ? WHERE ${guard} ON CONFLICT DO NOTHING`,
              mutation.id,
              mutation.folderId,
              mutation.id,
              mutation.folderId,
            )
          : prepare(
              'DELETE FROM node_tags WHERE tag_id = ? AND node_id = ?',
              mutation.id,
              mutation.folderId,
            )
        const result = await this.client.batch([
          write,
          prepare(`SELECT 1 AS present WHERE ${guard}`, mutation.id, mutation.folderId),
        ])
        return result[1]?.results.length === 1
      }
      if (mutation.type === 'create') {
        const result = await prepare(
          `INSERT INTO tags (id, name, name_key) SELECT ?, ?, ? WHERE (SELECT count(*) FROM tags) < ${MAX_TEMPLATE_TAGS}`,
          mutation.id,
          mutation.name,
          tagNameKey(mutation.name),
        ).run()
        if (result.meta.changes === 0)
          throw new TagConflictError(`The ${MAX_TEMPLATE_TAGS}-tag limit was reached.`)
        return true
      }
      if (mutation.type === 'assign') {
        const guard =
          'EXISTS (SELECT 1 FROM tags WHERE id = ?) AND EXISTS (SELECT 1 FROM templates WHERE id = ?)'
        const write = mutation.attached
          ? prepare(
              `INSERT INTO template_tags (tag_id, template_id) SELECT ?, ? WHERE ${guard} ON CONFLICT DO NOTHING`,
              mutation.id,
              mutation.templateId,
              mutation.id,
              mutation.templateId,
            )
          : prepare(
              'DELETE FROM template_tags WHERE tag_id = ? AND template_id = ?',
              mutation.id,
              mutation.templateId,
            )
        const results = await this.client.batch([
          write,
          prepare(
            `${bumpRevisions} id = ? AND ${guard}`,
            now,
            mutation.templateId,
            mutation.id,
            mutation.templateId,
          ),
        ])
        return (results[1]?.meta.changes ?? 0) > 0
      }
      const updateRevisions = prepare(
        `${bumpRevisions} id IN (SELECT template_id FROM template_tags WHERE tag_id = ?)`,
        now,
        mutation.id,
      )
      const write =
        mutation.type === 'rename'
          ? prepare(
              'UPDATE tags SET name = ?, name_key = ? WHERE id = ?',
              mutation.name,
              tagNameKey(mutation.name),
              mutation.id,
            )
          : prepare('DELETE FROM tags WHERE id = ?', mutation.id)
      const results = await this.client.batch([updateRevisions, write])
      return (results[1]?.meta.changes ?? 0) > 0
    } catch (error) {
      if (violates(error, 'unique', TAG_NAME_UNIQUE))
        throw new TagConflictError('A tag with that name already exists.')
      throw error
    }
  }
}
