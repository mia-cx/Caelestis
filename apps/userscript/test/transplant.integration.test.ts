import { decodePng, decodeWplaceIndexedPng, type TemplateSurface } from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { moveServerTemplateToServer } from '../src/application/transfer.js'
import { transplant } from '../src/application/transplant.js'
import '../src/application/tree-server-state.js'
import { createLocalFolder } from '../src/local-folders.js'
import { upsertServer } from '../src/server-connections.js'
import { admittedManifest } from '../src/server-manifests.js'
import { getState, type ServerConnection } from '../src/settings.js'
import { templateById } from '../src/templates/catalog.js'
import { putTemplateCopy } from '../src/templates/template-copies.js'
import { addLocalTemplate, setTemplateFolder } from '../src/templates/template-edits.js'
import { serverTemplateKey } from '../src/tree-keys.js'
import { adminToken, createTestBackend } from './backend.js'

const ids = {
  source: '018f1b8c-7f4e-7a8c-8234-123456789abc',
  destination: '018f1b8c-7f4e-7a8c-8234-123456789abd',
  sourceVersion: '018f1b8c-7f4e-7a8c-8234-223456789abc',
  destinationVersion: '018f1b8c-7f4e-7a8c-8234-223456789abd',
}
const stamp = 1_700_000_000_000
const server = (url: string, id: string): ServerConnection => ({
  url,
  info: { id, name: url, auth: 'access_token' },
  token: 'admin',
  status: 'connected',
  isAdmin: true,
  season: 7,
})
/** Draw a server template the way server sync does, so a transfer finds a current copy of it. */
const drawServerCopy = async (
  owner: ServerConnection,
  templateId: string,
  name: string,
  version: string,
  surface?: TemplateSurface,
) => {
  const id = serverTemplateKey(owner.url, templateId, surface)
  await putTemplateCopy({
    id,
    name,
    source: 'wplace',
    originX: 10,
    originY: 20,
    width: 2,
    height: 2,
    indices: new Uint8Array([1, 2, 3, 4]),
    moved: 0,
    opaque: 4,
    ...(surface === undefined ? {} : { surface }),
    origin: 'server',
    server: owner,
    serverTemplateId: templateId,
    nodeId: null,
    version,
    unpublished: false,
    wrapX: false,
    tileKeys: surface === undefined ? ['0/0'] : [],
  })
  const drawn = templateById(id)
  if (drawn === undefined) throw new Error('the server copy was not drawn')
  return drawn
}
const published = {
  id: ids.source,
  nodeId: null,
  name: 'Transferred art',
  version: ids.sourceVersion,
  published: true,
  updatedAt: stamp,
}
const fullManifest = (owner: ServerConnection) => ({
  version: 'revision',
  season: 7,
  surface: { kind: 'world', allianceId: null },
  server: owner.info,
  nodes: [],
  tiles: ['0/0'],
  templates: [
    {
      id: ids.destination,
      nodeId: null,
      name: published.name,
      version: ids.destinationVersion,
      totalPixels: 4,
      published: true,
      createdAt: stamp,
      updatedAt: stamp,
      bbox: { minX: 10, minY: 20, maxX: 12, maxY: 22 },
      chunks: [{ tile: '0/0', hash: 'a'.repeat(64) }],
    },
  ],
})

/** The source row the tree last drew; a test replaces it to simulate another admin's edit. */
const sourceRow = vi.hoisted(() => ({ edited: null as object | null }))
/** The alliance manifest the alliance sync last admitted; null until a test admits one. */
const allianceManifest = vi.hoisted(() => ({ admitted: null as object | null }))

// Refreshing the tree after each write is the panel's business. Admission still reads the
// destination over the network.
vi.mock('../src/application/tree-server-state.js', async (original) => ({
  ...(await original<typeof import('../src/application/tree-server-state.js')>()),
  serverTemplateAt: () => sourceRow.edited ?? published,
}))
vi.mock('../src/server-manifests.js', async (original) => {
  const store = await original<typeof import('../src/server-manifests.js')>()
  return {
    ...store,
    manifestRows: (...[server, surface]: Parameters<typeof store.manifestRows>) =>
      surface !== undefined && surface.kind !== 'world'
        ? (allianceManifest.admitted ?? undefined)
        : store.manifestRows(server, surface),
  }
})
vi.mock('../src/application/tree-server.js', async (original) => ({
  ...(await original<typeof import('../src/application/tree-server.js')>()),
  refreshEditedSurface: async () => {},
}))

afterEach(() => {
  sourceRow.edited = null
  allianceManifest.admitted = null
  vi.unstubAllGlobals()
})

describe('cross-server template transplant', () => {
  it('admits a Local folder branch at the server before removing its persisted source', async () => {
    // Happy DOM cannot decode Node Blob values. Keep PNG decoding real at the browser boundary.
    type Bitmap = Awaited<ReturnType<typeof decodePng>>
    vi.stubGlobal('createImageBitmap', async (blob: Blob) => ({
      ...(await decodePng(new Uint8Array(await blob.arrayBuffer()))),
      close() {},
    }))
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          let bitmap: Bitmap | undefined
          return {
            drawImage: (source: Bitmap) => {
              bitmap = source
            },
            getImageData: () => {
              if (!bitmap) throw new Error('No image drawn')
              return new ImageData(
                new Uint8ClampedArray(bitmap.pixels),
                bitmap.width,
                bitmap.height,
              )
            },
          }
        }
      },
    )
    const { app } = await createTestBackend()
    const destination: ServerConnection = {
      url: 'https://destination-local-folder.test',
      info: {
        id: '00000000-0000-7000-8000-000000000000',
        name: 'Userscript contract server',
        auth: 'access_token',
      },
      token: adminToken,
      status: 'connected',
      isAdmin: true,
      season: 3,
    }
    upsertServer(destination)
    const currentDestination = getState().servers.find((item) => item.url === destination.url)
    if (currentDestination === undefined) throw new Error('destination connection was not retained')
    const sourceFolder = createLocalFolder(null, 'Local collection')
    if (sourceFolder === null) throw new Error('source folder was not created')
    const sourceTemplate = await addLocalTemplate(
      {
        id: `local-folder-${crypto.randomUUID()}`,
        name: 'Local pixels',
        source: 'wplace',
        originX: 10,
        originY: 20,
        width: 2,
        height: 2,
        indices: new Uint8Array([4, 3, 2, 1]),
        moved: 0,
        opaque: 4,
      },
      undefined,
      true,
    )
    expect(await setTemplateFolder(sourceTemplate.id, sourceFolder.id)).toBe(true)

    let upload: Uint8Array | undefined
    let sourceWasPresentWhenDestinationWasListed = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(String(input), init)
      const url = new URL(request.url)
      if (url.hostname !== 'destination-local-folder.test') {
        throw new Error(`unexpected request: ${request.method} ${url}`)
      }
      if (url.pathname.endsWith('/admin/templates') && request.method === 'POST') {
        upload = new Uint8Array(
          await ((await request.clone().formData()).get('png') as Blob).arrayBuffer(),
        )
      }
      if (url.pathname.endsWith('/manifest')) {
        sourceWasPresentWhenDestinationWasListed =
          templateById(sourceTemplate.id) !== undefined &&
          getState().localFolders.some((folder) => folder.id === sourceFolder.id)
      }
      const backendPath = url.pathname.replace(/^\/backend\/v1(?=\/|$)/, '')
      return await app.fetch(
        new Request(`https://backend.test${backendPath}${url.search}`, request),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    window.fetch = fetchMock as typeof window.fetch

    const result = await transplant(
      { kind: 'local', folderId: sourceFolder.id },
      { kind: 'server', server: currentDestination, nodeId: null },
      () => {},
    )

    if (!result.ok || result.destinationId === undefined) throw new Error(result.message)
    expect(result.message).toBe('Moved “Local collection” — 1 folder, 1 template.')
    if (upload === undefined) throw new Error('template upload was not captured')
    expect(await decodeWplaceIndexedPng(upload)).toEqual({
      width: 2,
      height: 2,
      indices: new Uint8Array([4, 3, 2, 1]),
    })
    expect(sourceWasPresentWhenDestinationWasListed).toBe(true)
    const admitted = admittedManifest(currentDestination)
    if (admitted === null) throw new Error('destination manifest was not admitted')
    expect(admitted).toMatchObject({
      nodes: [expect.objectContaining({ id: result.destinationId, name: sourceFolder.name })],
      templates: [
        expect.objectContaining({
          nodeId: result.destinationId,
          name: sourceTemplate.name,
        }),
      ],
    })
    expect(templateById(sourceTemplate.id)).toBeUndefined()
    expect(getState().localFolders.some((folder) => folder.id === sourceFolder.id)).toBe(false)
  })

  it('moves a server folder on an alliance surface using its drawn alliance copies', async () => {
    const surface: TemplateSurface = { kind: 'alliance-picture', allianceId: 42 }
    const source = server('https://alliance-source.test', '018f1b8c-7f4e-7a8c-8a01-123456789abc')
    upsertServer(source)
    const currentSource = getState().servers.find((item) => item.url === source.url)!
    const folder = {
      id: '018f1b8c-7f4e-7a8c-8234-323456789abc',
      parentId: null,
      path: '/Banner art',
      name: 'Banner art',
      createdAt: stamp,
    }
    const row = { ...published, nodeId: folder.id }
    allianceManifest.admitted = { nodes: [folder], templates: [row] }
    await drawServerCopy(currentSource, row.id, row.name, row.version, surface)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      // The source version was published without a recipe.
      if (url.pathname.includes('/recipes/')) return new Response(null, { status: 404 })
      if (url.pathname.endsWith('/admin/nodes') && url.searchParams.get('allianceId') === '42')
        return Response.json({ nodes: [folder] })
      if (init?.method === 'DELETE') return Response.json({})
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    window.fetch = fetchMock as typeof window.fetch

    const result = await transplant(
      { kind: 'server', server: currentSource, nodeId: folder.id },
      { kind: 'local', folderId: null },
      () => {},
      surface,
    )

    expect(result).toMatchObject({
      ok: true,
      message: 'Moved “Banner art” — 1 folder, 1 template.',
    })
    const moved = getState().localFolders.find((local) => local.id === result.destinationId)
    expect(moved).toMatchObject({ name: folder.name, surface })
  })

  it('uses real persisted pixels, admits a canonical manifest, then deletes the source', async () => {
    const source = server('https://source.test', '018f1b8c-7f4e-7a8c-8a01-123456789abc')
    const destination = server('https://destination.test', '018f1b8c-7f4e-7a8c-8a01-123456789abd')
    upsertServer(source)
    upsertServer(destination)
    const currentSource = getState().servers.find((item) => item.url === source.url)!
    const currentDestination = getState().servers.find((item) => item.url === destination.url)!
    const drawn = await drawServerCopy(currentSource, ids.source, published.name, ids.sourceVersion)
    let upload: Uint8Array | undefined
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      // The source version was published without a recipe.
      if (url.pathname.includes('/recipes/')) return new Response(null, { status: 404 })
      if (
        url.hostname === 'destination.test' &&
        url.pathname.endsWith('/admin/templates') &&
        init?.method === 'POST'
      ) {
        upload = new Uint8Array(
          await new Response((init.body as FormData).get('png') as Blob).arrayBuffer(),
        )
        return Response.json(
          { templateId: ids.destination, versionId: ids.destinationVersion },
          { status: 201 },
        )
      }
      if (
        url.hostname === 'destination.test' &&
        url.pathname.endsWith(`/admin/templates/${ids.destination}`)
      )
        return Response.json({})
      if (url.hostname === 'destination.test' && url.pathname.endsWith('/manifest'))
        return Response.json(fullManifest(currentDestination))
      if (url.hostname === 'source.test' && url.pathname.endsWith(`/admin/templates/${ids.source}`))
        return Response.json({})
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    window.fetch = fetchMock as typeof window.fetch
    const result = await moveServerTemplateToServer(
      currentSource,
      currentDestination,
      null,
      published,
      drawn,
      () => {},
    )
    expect(result).toMatchObject({ ok: true, destinationId: ids.destination })
    expect(await decodeWplaceIndexedPng(upload!)).toEqual({
      width: 2,
      height: 2,
      indices: new Uint8Array([1, 2, 3, 4]),
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/admin/templates/${ids.source}`),
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('keeps the persisted source when a destination manifest cannot be admitted', async () => {
    const source = server('https://source-refusal.test', '018f1b8c-7f4e-7a8c-8a01-123456789abc')
    const destination = server(
      'https://destination-refusal.test',
      '018f1b8c-7f4e-7a8c-8a01-123456789abd',
    )
    upsertServer(source)
    upsertServer(destination)
    const currentSource = getState().servers.find((item) => item.url === source.url)!
    const currentDestination = getState().servers.find((item) => item.url === destination.url)!
    const drawn = await drawServerCopy(currentSource, ids.source, published.name, ids.sourceVersion)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      // The source version was published without a recipe.
      if (url.pathname.includes('/recipes/')) return new Response(null, { status: 404 })
      if (
        url.hostname === 'destination-refusal.test' &&
        url.pathname.endsWith('/admin/templates') &&
        init?.method === 'POST'
      )
        return Response.json(
          { templateId: ids.destination, versionId: ids.destinationVersion },
          { status: 201 },
        )
      if (
        url.hostname === 'destination-refusal.test' &&
        url.pathname.endsWith(`/admin/templates/${ids.destination}`)
      )
        return Response.json({})
      if (url.hostname === 'destination-refusal.test' && url.pathname.endsWith('/manifest'))
        return Response.json({})
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    window.fetch = fetchMock as typeof window.fetch
    const result = await moveServerTemplateToServer(
      currentSource,
      currentDestination,
      null,
      published,
      drawn,
      () => {},
    )
    expect(result).toMatchObject({ ok: false, destinationId: ids.destination })
    expect(templateById(drawn.id)).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining(`/admin/templates/${ids.source}`),
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('keeps the source when it is edited while its copy uploads', async () => {
    const source = server('https://source-edited.test', '018f1b8c-7f4e-7a8c-8a01-123456789abc')
    const destination = server(
      'https://destination-edited.test',
      '018f1b8c-7f4e-7a8c-8a01-123456789abd',
    )
    upsertServer(source)
    upsertServer(destination)
    const currentSource = getState().servers.find((item) => item.url === source.url)!
    const currentDestination = getState().servers.find((item) => item.url === destination.url)!
    const drawn = await drawServerCopy(currentSource, ids.source, published.name, ids.sourceVersion)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      // The source version was published without a recipe.
      if (url.pathname.includes('/recipes/')) return new Response(null, { status: 404 })
      if (
        url.hostname === 'destination-edited.test' &&
        url.pathname.endsWith('/admin/templates') &&
        init?.method === 'POST'
      ) {
        sourceRow.edited = { ...published, name: 'Renamed meanwhile', updatedAt: stamp + 1 }
        return Response.json(
          { templateId: ids.destination, versionId: ids.destinationVersion },
          { status: 201 },
        )
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    window.fetch = fetchMock as typeof window.fetch
    const result = await moveServerTemplateToServer(
      currentSource,
      currentDestination,
      null,
      published,
      drawn,
      () => {},
    )
    expect(result).toEqual({
      ok: false,
      tone: 'warning',
      destinationId: ids.destination,
      message: `Copied to ${destination.url} as a draft, but the source changed and was kept.`,
    })
    // Besides reading the source's recipe, only the upload reached a server: nothing was deleted.
    expect(
      fetchMock.mock.calls.filter(([input]) => !String(input).includes('/recipes/')),
    ).toHaveLength(1)
  })
})
