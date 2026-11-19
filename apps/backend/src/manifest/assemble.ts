import {
  type Manifest,
  type ServerInfo,
  type SurfaceChunkKey,
  sha256Hex,
  type TemplateSurface,
  type TemplateTag,
  tileKey,
} from '@caelestis/shared'
import {
  MAX_MANIFEST_CHUNKS,
  MAX_MANIFEST_NODES,
  MAX_MANIFEST_TEMPLATES,
} from '@caelestis/wire-schema'
import { Effect } from 'effect'
import type { NodeStore } from '../nodes/store.js'
import { SqlStoreService } from '../runtime/backend-runtime.js'
import { type StorageError, storage } from '../runtime/errors.js'
import type { TagStore } from '../tags/store.js'
import type { TemplateStore } from '../templates/store.js'
import type { WorkStore } from '../work/store.js'

/** The stores a manifest is assembled from. */
export type ManifestStores = NodeStore & TemplateStore & TagStore & { readonly work: WorkStore }

export interface AssembleManifestOptions {
  readonly server: ServerInfo
  readonly season: number
  readonly surface?: TemplateSurface
  readonly includeUnpublished: boolean
}

const VERSION_PLACEHOLDER = '0'.repeat(64)

/** Assemble one visibility-scoped manifest and sign it with the hash of its content. */
export const assembleManifest = async (
  sql: ManifestStores,
  options: AssembleManifestOptions,
): Promise<Manifest> => {
  const surface = options.surface ?? { kind: 'world', allianceId: null }
  const [
    nodeRecords,
    templateRecords,
    tileRecords,
    tagRecords,
    catalog,
    nodeTagRecords,
    workRevision,
  ] = await Promise.all([
    sql.listNodes(options.season, surface),
    sql.listManifestTemplates({ season: options.season, surface }, options.includeUnpublished),
    sql.listManifestTiles({ season: options.season, surface }, options.includeUnpublished),
    sql.listManifestTags({ season: options.season, surface }, options.includeUnpublished),
    options.includeUnpublished ? sql.listTags() : Promise.resolve([]),
    sql.listManifestNodeTags({ season: options.season, surface }),
    sql.work.revision(options.season, surface),
  ])

  const tagsByTemplate = new Map<string, TemplateTag[]>()
  for (const { templateId, tag } of tagRecords) {
    const tags = tagsByTemplate.get(templateId) ?? []
    tags.push(tag)
    tagsByTemplate.set(templateId, tags)
  }
  for (const tags of tagsByTemplate.values()) tags.sort((a, b) => a.id.localeCompare(b.id))
  const tagsByNode = new Map<string, TemplateTag[]>()
  for (const { nodeId, tag } of nodeTagRecords) {
    const tags = tagsByNode.get(nodeId) ?? []
    tags.push(tag)
    tagsByNode.set(nodeId, tags)
  }
  for (const tags of tagsByNode.values()) tags.sort((a, b) => a.id.localeCompare(b.id))

  const allNodes = nodeRecords
    .map(({ id, parentId, path, name, description, createdAt }) =>
      description === null
        ? { id, parentId, path, name, createdAt }
        : { id, parentId, path, name, description, createdAt },
    )
    .map((node) => ({
      ...node,
      ...(tagsByNode.has(node.id) ? { tags: tagsByNode.get(node.id) ?? [] } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  const chunksByVersion = new Map<string, Array<{ tile: SurfaceChunkKey; hash: string }>>()
  for (const record of tileRecords) {
    const chunk = {
      tile: tileKey({ x: record.tileX, y: record.tileY }) as SurfaceChunkKey,
      hash: record.hash,
    }
    const key = `${record.templateId}:${record.versionId}`
    const chunks = chunksByVersion.get(key)
    if (chunks === undefined) chunksByVersion.set(key, [chunk])
    else chunks.push(chunk)
  }

  // Nodes, templates and tiles are separate reads with no snapshot between them, so a write landing
  // in the gap can be seen by one and not another. A template with no tiles, or naming a node the
  // manifest does not carry, would make a manifest the wire refuses to decode. Dropping it is the
  // recoverable direction: the next poll carries it complete. Orphan tile rows simply find no
  // template to attach to.
  const nodeIds = new Set(allNodes.map((node) => node.id))
  const templates = templateRecords
    .filter(
      (template) =>
        (template.nodeId === null || nodeIds.has(template.nodeId)) &&
        (chunksByVersion.get(`${template.id}:${template.versionId}`)?.length ?? 0) > 0,
    )
    .map((template) => ({
      id: template.id,
      nodeId: template.nodeId,
      name: template.name,
      ...(tagsByTemplate.has(template.id) ? { tags: tagsByTemplate.get(template.id) ?? [] } : {}),
      version: template.versionId,
      bbox: { ...template.bbox },
      totalPixels: template.totalPixels,
      chunks: (chunksByVersion.get(`${template.id}:${template.versionId}`) ?? []).sort(
        (left, right) => left.tile.localeCompare(right.tile),
      ),
      published: template.published,
      finished: template.finished,
      finishedAt: template.finishedAt,
      timelapseFrozen: template.timelapseFrozen,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  // Below admin, a folder appears only above a published template. A folder holding nothing but
  // drafts would name and tag them.
  const parents = new Map(allNodes.map((node) => [node.id, node.parentId]))
  const shown = new Set<string>()
  for (const template of templates) {
    for (let id = template.nodeId; id !== null && !shown.has(id); id = parents.get(id) ?? null) {
      shown.add(id)
    }
  }
  const nodes = options.includeUnpublished
    ? allNodes
    : allNodes.filter((node) => shown.has(node.id))

  // The wire bounds nodes, templates and total chunks, and no write path enforces those aggregates.
  // A season past one would assemble a manifest every client refuses to decode, so name the cause
  // here instead.
  const refuse = (count: number, limit: number, what: string) => {
    if (count > limit) {
      throw new Error(
        `season ${options.season} assembles ${count} ${what}, more than the ${limit} a manifest may carry`,
      )
    }
  }
  refuse(nodes.length, MAX_MANIFEST_NODES, 'nodes')
  refuse(templates.length, MAX_MANIFEST_TEMPLATES, 'templates')
  refuse(
    templates.reduce((total, template) => total + template.chunks.length, 0),
    MAX_MANIFEST_CHUNKS,
    'chunks',
  )

  const tiles = [
    ...new Set(templates.flatMap((template) => template.chunks.map(({ tile }) => tile))),
  ].sort((left, right) => left.localeCompare(right))
  // Fixed field order keeps the content hash stable regardless of the caller's object key order.
  const server = options.server
  const normalizedServer: ServerInfo = {
    id: server.id,
    name: server.name,
    ...(server.description === undefined ? {} : { description: server.description }),
    auth: server.auth,
    ...(server.liveSync === undefined ? {} : { liveSync: server.liveSync }),
    ...(server.liveSyncMax === undefined ? {} : { liveSyncMax: server.liveSyncMax }),
    ...(server.liveTileOffers === undefined ? {} : { liveTileOffers: server.liveTileOffers }),
    ...(server.presence === undefined ? {} : { presence: server.presence }),
    ...(server.livePaintParts === undefined ? {} : { livePaintParts: server.livePaintParts }),
    ...(server.discordInviteUrl === undefined ? {} : { discordInviteUrl: server.discordInviteUrl }),
    ...(server.version === undefined ? {} : { version: server.version }),
    ...(server.build === undefined ? {} : { build: server.build }),
    ...(server.homeCopy === undefined ? {} : { homeCopy: server.homeCopy }),
    ...(server.logoText === undefined ? {} : { logoText: server.logoText }),
    ...(server.logoImage === undefined
      ? {}
      : {
          logoImage: { etag: server.logoImage.etag, contentType: server.logoImage.contentType },
        }),
    ...(server.previewImage === undefined
      ? {}
      : {
          previewImage: {
            etag: server.previewImage.etag,
            contentType: server.previewImage.contentType,
          },
        }),
  }
  const unsigned: Manifest = {
    ...(catalog.length === 0
      ? {}
      : { tags: [...catalog].sort((a, b) => a.id.localeCompare(b.id)) }),
    version: VERSION_PLACEHOLDER,
    season: options.season,
    ...(surface.kind === 'world' ? {} : { surface }),
    server: normalizedServer,
    nodes,
    templates,
    tiles,
    ...(workRevision === 0 ? {} : { workRevision }),
  }
  const version = await sha256Hex(new TextEncoder().encode(JSON.stringify(unsigned)))
  return { ...unsigned, version }
}

/** Assemble one manifest from the SQL service supplied by the prepared backend runtime. */
export const assembleManifestEffect = (
  options: AssembleManifestOptions,
): Effect.Effect<Manifest, StorageError, SqlStoreService> =>
  Effect.gen(function* () {
    const sql = yield* SqlStoreService
    return yield* storage('assembleManifest', () => assembleManifest(sql, options))
  })
