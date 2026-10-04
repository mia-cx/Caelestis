import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  encodeIndexedPng,
  sha256Hex,
  type TemplateRecipe,
  templateRecipeJson,
  uuidV7,
} from '@caelestis/shared'
import type { ObjectStorage, PutOptions, StoredObject } from '@caelestis/storage'
import { FilesystemObjectStorage } from '@caelestis/storage/filesystem'
import { expect } from 'vitest'
import { coordinatorDatabase } from '../../src/adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../../src/adapters/node/coordinator-storage.js'
import type { ArchiveClient } from '../../src/archive/cli.js'
import { type NodeConfig, readNodeConfig } from '../../src/node/config.js'
import { openNodeRuntime } from '../../src/node/runtime.js'

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export const ARCHIVE_ADMIN = 'ARCHIVE-ADMIN-TOKEN'
const SEASON = 0

export const archiveClient = (fetch: Fetch, api: string): ArchiveClient => ({
  api,
  token: ARCHIVE_ADMIN,
  fetch,
  wait: async () => {},
})

/** A portable server: the Node runtime over any database configuration and object store. */
export const openPortableServer = async (
  options: {
    readonly env?: Readonly<Record<string, string>>
    readonly config?: (config: NodeConfig) => NodeConfig
    readonly objects?: ObjectStorage
  } = {},
) => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'caelestis-archive-'))
  const base = readNodeConfig({
    DATA_DIRECTORY: directory,
    ADMIN_TOKEN: ARCHIVE_ADMIN,
    SERVER_ID: '01890f3e-7b2c-7abc-8def-0000000000aa',
    ARCHIVE_SETTLE_SECONDS: '0',
    SEASON: String(SEASON),
    ...options.env,
  })
  const runtime = await openNodeRuntime(
    options.config?.(base) ?? base,
    options.objects ?? new FilesystemObjectStorage(join(directory, 'objects')),
    { onOwnershipLost() {} },
  )
  const fetch: Fetch = async (input, init) => runtime.app.fetch(new Request(input, init))
  return {
    runtime,
    fetch,
    api: 'https://portable.test/v1',
    close: async () => {
      await runtime.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/**
 * Object storage without disk syncs, for cases about paging rather than durability. It keeps
 * the contract's byte-ordered listing and adapter-owned cursors.
 */
export class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, StoredObject>()
  async head(key: string) {
    const object = this.objects.get(key)
    if (object === undefined) return null
    const { bytes: _, ...info } = object
    return info
  }
  async get(key: string) {
    return this.objects.get(key) ?? null
  }
  async put(key: string, bytes: Uint8Array, options: PutOptions = {}) {
    if (options.ifAbsent && this.objects.has(key)) return null
    const object: StoredObject = {
      bytes: bytes.slice(),
      size: bytes.byteLength,
      etag: await sha256Hex(bytes),
      uploadedAt: Date.now(),
      metadata: { ...options.metadata },
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    }
    this.objects.set(key, object)
    const { bytes: _, ...info } = object
    return info
  }
  async delete(keys: readonly string[]) {
    for (const key of keys) this.objects.delete(key)
  }
  async list(prefix: string, options: { cursor?: string; limit: number }) {
    const keys = [...this.objects.keys()]
      .filter(
        (key) => key.startsWith(prefix) && (options.cursor === undefined || key > options.cursor),
      )
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    const page = keys.slice(0, options.limit)
    const last = page.at(-1)
    return keys.length > options.limit && last !== undefined
      ? { keys: page, cursor: last }
      : { keys: page }
  }
}

/** A running Eralyon import with no tiles left to fetch, so its wakeups end quietly. */
export const runningImport = (templateId: string) => ({
  summary: { status: 'running', completed: 0, basis: { templateId } },
  snapshots: [],
  tiles: [],
})

/** One template's resumable import state on a portable server. */
export const backfillState = (
  server: Awaited<ReturnType<typeof openPortableServer>>,
  templateId: string,
) =>
  new SqlCoordinatorStorage(
    coordinatorDatabase(server.runtime.connection),
    `backfill:${templateId}`,
  )

const canvas = await readFile(
  new URL('../../../../scripts/stack-tests/canvas.png', import.meta.url),
)

/**
 * Exercise the public API so most tables, every object prefix the server writes, and the
 * telemetry coordinator hold real data. Returns what a replay test needs.
 */
export const seedServer = async (fetch: Fetch, api: string) => {
  const call = async (path: string, init: RequestInit & { token?: string } = {}, status = 200) => {
    const { token = ARCHIVE_ADMIN, ...rest } = init
    const response = await fetch(`${api}${path}`, {
      ...rest,
      headers: { authorization: `Bearer ${token}`, ...rest.headers },
    })
    const text = await response.text()
    expect(response.status, `${path}: ${text}`).toBe(status)
    return text ? (JSON.parse(text) as Record<string, unknown>) : {}
  }
  const json = (body: unknown) => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const report = await call(
    '/admin/tokens',
    { method: 'POST', ...json({ label: 'reporter', scope: 'report' }) },
    201,
  )
  const revoked = await call(
    '/admin/tokens',
    { method: 'POST', ...json({ label: 'retired', scope: 'read' }) },
    201,
  )
  await call(`/admin/tokens/${revoked.tokenHash}`, { method: 'DELETE' }, 204)
  await call('/admin/server', {
    method: 'PATCH',
    ...json({ name: 'Archived server', description: 'Moves between hosts' }),
  })
  await call('/admin/server/assets/logo', {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: await encodeIndexedPng(2, 2, new Uint8Array([1, 2, 2, 1])),
  })

  const folder = await call(
    '/admin/nodes',
    { method: 'POST', ...json({ season: SEASON, parentId: null, name: 'Murals' }) },
    201,
  )
  const child = await call(
    '/admin/nodes',
    { method: 'POST', ...json({ season: SEASON, parentId: folder.id, name: 'North' }) },
    201,
  )
  const source = await encodeIndexedPng(4, 2, new Uint8Array([1, 1, 2, 2, 1, 1, 2, 2]))
  const recipe: TemplateRecipe = {
    format: 1,
    processor: 'wplace-native',
    processorVersion: 1,
    source: { sha256: await sha256Hex(source), width: 4, height: 2 },
    width: 2,
    height: 1,
    colorMetric: 'lab',
    dithering: false,
    legacyDecode: false,
    palette: [0, 1, 2],
  }
  const form = new FormData()
  form.set('png', new File([await encodeIndexedPng(2, 1, new Uint8Array([1, 2]))], 'art.png'))
  form.set('source', new File([source], 'source.png'))
  form.set('recipe', templateRecipeJson(recipe))
  form.set('nodeId', String(child.id))
  form.set('name', 'Archived mural')
  form.set('originX', '0')
  form.set('originY', '0')
  const template = await call('/admin/templates', { method: 'POST', body: form }, 201)
  const templateId = String(template.templateId)
  await call(`/admin/templates/${templateId}`, { method: 'PATCH', ...json({ published: true }) })
  const tag = await call('/admin/tags', { method: 'POST', ...json({ name: 'portable' }) }, 201)
  await call(`/admin/tags/${tag.id}/templates/${templateId}`, { method: 'PUT' }, 204)
  await call(`/admin/tags/${tag.id}/folders/${folder.id}`, { method: 'PUT' }, 204)

  const workId = uuidV7()
  await call(`/work/${workId}?season=${SEASON}&surface=world`, {
    method: 'PUT',
    ...json({
      action: 'create',
      actor: { wplaceUserId: 42, displayName: 'Mia' },
      expectedRevision: 0,
      fields: {
        title: 'Restore mural',
        description: 'Fill the corner.',
        status: 'open',
        priority: 'normal',
        tags: ['repair'],
        blockerIds: [],
        nodeId: null,
        templateIds: [templateId],
      },
    }),
  })

  const now = Math.floor(Date.now() / 1_000)
  await call(`/telemetry/tiles/0/0/${await sha256Hex(canvas)}`, {
    method: 'PUT',
    token: String(report.token),
    body: canvas,
    headers: {
      'x-caelestis-season': String(SEASON),
      'x-caelestis-observed-at': String(now),
      'x-caelestis-wplace-user-id': '42',
      'x-caelestis-display-name': 'Mia',
    },
  })
  const event = {
    eventId: uuidV7(),
    wplaceUserId: 42,
    displayName: 'Mia',
    season: SEASON,
    ts: now,
    painted: 1,
    tiles: [{ x: 0, y: 0, pixels: { x: [0], y: [0], colors: [1] } }],
  }
  expect(await paint(fetch, api, String(report.token), event)).toMatchObject({ accepted: true })
  return { templateId, reportToken: String(report.token), event }
}

export const paint = async (fetch: Fetch, api: string, token: string, event: unknown) =>
  (await (
    await fetch(`${api}/telemetry/paints`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(event),
    })
  ).json()) as Record<string, unknown>

/**
 * An archive's data independent of who wrote it and where: no header or end record, no runtime
 * frontend credential, in sorted order because each database sorts text its own way.
 */
export const archiveData = (archive: string) =>
  archive
    .split('\n')
    .filter((line) => line.length > 0)
    .map(
      (line) => JSON.parse(line) as { kind: string; table?: string; values?: { label?: string } },
    )
    .filter(
      (record) =>
        record.kind !== 'header' &&
        record.kind !== 'end' &&
        !(record.table === 'access_tokens' && record.values?.label === 'Built-in frontend'),
    )
    .map((record) => JSON.stringify(record))
    .sort()
