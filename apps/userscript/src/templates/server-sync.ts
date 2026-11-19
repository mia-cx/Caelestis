import {
  PALETTE_RGB,
  quantiseToPalette,
  sameTemplateSurface,
  sha256Hex,
  type TemplateSurface,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  templateSurfaceKey,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { Semaphore } from '../concurrency.js'
import { count, warn } from '../debug.js'
import { PerServerMap } from '../per-server-map.js'
import {
  type ConnectedServer,
  connectedServers,
  isConnected,
  isCurrentServerConnection,
  onServerRemoved,
  serverConnectionIdentity,
  serverConnectionSignal,
} from '../server-connections.js'
import type { ServerTemplate } from '../server-manifest.js'
import {
  adoptProbedManifest,
  applyLiveManifest,
  onManifestChange,
  readManifest,
} from '../server-manifests.js'
import { invalidateServerMismatches } from '../server-mismatch.js'
import { deleteCachedServerMismatches } from '../server-mismatch-cache.js'
import { serverRequest } from '../server-request.js'
import { applyServerSyncRevision, registerServerSyncResource } from '../server-sync-coordinator.js'
import { onStateChange, type ServerConnection } from '../settings.js'
import { serverTemplateIdPrefix, serverTemplateKey } from '../tree-keys.js'
import { ByteCache } from './byte-cache.js'
import { localTemplates, type ServerCopy } from './catalog.js'
import { cachedServerCopy, retainServerPixels } from './server-pixel-cache.js'
import {
  forgetTemplateCopies,
  forgetTemplateCopy,
  hasRoomForCopy,
  putTemplateCopy,
  setServerPixelSource,
  updateServerTemplateMetadata,
} from './template-copies.js'

/**
 * Bringing a server's published templates onto the canvas.
 *
 * The manifest says which templates exist and, per template, which tile each of its chunks covers
 * and the hash of that chunk. Chunks are content-addressed and served immutable, so this is a
 * download that gets cheaper the more of it you have already done: a new version that changed one
 * corner shares every other hash with the old one, and a rename shares all of them.
 *
 * The assembled result is handed to the same store local imports live in, which is what makes a
 * server template a first-class overlay — it renders, it can be filtered by colour, its mismatches
 * are marked, and the picker will answer from it, all without any of those knowing it came from
 * somewhere else.
 */

const CHUNK_CACHE_LIMIT = 512
/** Encoded cache budget. The entry cap alone permits 512 adversarial 8 MiB responses. */
const CHUNK_CACHE_BYTES = 64 * 1024 * 1024
const MAX_CHUNK_BYTES = 8 * 1024 * 1024
/** Matches the server upload boundary; a wider manifest is not one this client can safely drain. */
const MAX_TEMPLATE_CHUNKS = 400
/** Encoded work per template. Decoded pixels have their own 64M-pixel bound below. */
const MAX_TEMPLATE_TRANSFER_BYTES = 64 * 1024 * 1024
const MAX_TEMPLATE_ASSEMBLY_MS = 120_000
/** At most this many templates own network, decode, and bitmap memory at once. */
const assemblySlots = new Semaphore(4)

/** Chunk bytes by hash. Immutable by definition, so nothing here ever needs invalidating. */
const chunkCache = new ByteCache<string>(CHUNK_CACHE_LIMIT, CHUNK_CACHE_BYTES)
/**
 * Decoded palette indices by chunk hash, so a new version decodes only the chunks it changed.
 *
 * A hash fixes the PNG and therefore its dimensions; callers still check the declared size against
 * the slot before reusing an entry. Up to 32 full tiles of decoded pixels.
 */
const decodedChunks = new ByteCache<string>(CHUNK_CACHE_LIMIT, 32 * TILE_SIZE * TILE_SIZE)

/** Fetch one chunk without spending more than this template still has left. */
export const fetchChunkWithinBudget = async (
  server: ServerConnection,
  hash: string,
  downloadSignal: AbortSignal,
  remainingBytes: number,
): Promise<Uint8Array | null> => {
  if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0) return null
  const cached = chunkCache.get(hash)
  if (cached !== undefined) return cached.byteLength <= remainingBytes ? cached : null
  const readLimit = Math.min(MAX_CHUNK_BYTES, remainingBytes)
  try {
    const { response, body: bytes } = await serverRequest(server, `/chunks/${hash}`, {
      limits: 'background',
      read: 'bytes',
      maxBytes: readLimit,
      signal: downloadSignal,
    })
    if (!response.ok) return null
    // A configured server is not trusted to tell the truth about a content address. Verify before
    // admitting bytes to the global cache, otherwise one server can seed another server's hash.
    // `readLimit` also means an over-budget template never admits the chunk that would evict useful
    // entries and make the same rejected version redownload its whole prefix on every poll.
    if ((await sha256Hex(bytes)) !== hash) return null
    chunkCache.set(hash, bytes)
    return bytes
  } catch {
    return null
  }
}

/**
 * Whether a PNG's IHDR declares exactly this size. Read before asking the browser to decode:
 * checking the ImageBitmap afterwards is too late for a PNG that declares a gigantic surface.
 */
const declaresSize = (bytes: Uint8Array, width: number, height: number): boolean => {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  )
    return false
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return header.getUint32(16) === width && header.getUint32(20) === height
}

/** A chunk PNG whose declared size was already checked, as palette indices. */
const decodeChunk = async (
  bytes: Uint8Array,
  expectedWidth: number,
  expectedHeight: number,
): Promise<Uint8Array | null> => {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/png' }))
    if (bitmap.width !== expectedWidth || bitmap.height !== expectedHeight) {
      bitmap.close()
      return null
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return null
    context.drawImage(bitmap, 0, 0)
    const image = context.getImageData(0, 0, expectedWidth, expectedHeight)
    bitmap.close()
    count('server:chunk decoded')
    // The bytes are already palette colours — the server quantised on ingest — so this maps each to
    // itself. Going through the same quantiser as an import rather than trusting that is one pass
    // over a chunk, and it is the difference between a colour-managed decode being a bug and being
    // a non-event.
    return quantiseToPalette(new Uint8Array(image.data.buffer), PALETTE_RGB).indices
  } catch (error) {
    warn('could not decode a chunk', String(error))
    return null
  }
}

/**
 * Assemble a template's chunks into one bitmap the size of its bounding box.
 *
 * Where each chunk goes is derivable rather than stored: a chunk covers the intersection of the
 * template's box with one tile, so its top-left is the later of the two starts on each axis. That is
 * why the manifest carries only a tile and a hash per chunk.
 */
const assemble = async (
  server: ConnectedServer,
  template: ServerTemplate,
  downloadSignal: AbortSignal,
): Promise<{ width: number; height: number; indices: Uint8Array } | null> => {
  if (downloadSignal.aborted) return null
  const surface = template.surface ?? WORLD_TEMPLATE_SURFACE
  const wrapsX = surface.kind === 'world' && template.bbox.minX > template.bbox.maxX
  const width = wrapsX
    ? WORLD_PIXELS - template.bbox.minX + template.bbox.maxX
    : template.bbox.maxX - template.bbox.minX
  const height = template.bbox.maxY - template.bbox.minY
  if (
    width <= 0 ||
    height <= 0 ||
    width * height > 64_000_000 ||
    template.chunks.length > MAX_TEMPLATE_CHUNKS
  )
    return null

  const indices = new Uint8Array(width * height).fill(TRANSPARENT_INDEX)
  let placed = 0
  let encodedBytes = 0
  // Chunks already decoded go first. Each decode may evict the oldest entry, and in manifest order
  // a template larger than the cache would evict the very chunks it is about to reuse.
  const isDecoded = (chunk: { readonly hash: string }) =>
    decodedChunks.get(chunk.hash) !== undefined
  const ordered = [
    ...template.chunks.filter(isDecoded),
    ...template.chunks.filter((chunk) => !isDecoded(chunk)),
  ]
  for (const chunk of ordered) {
    if (downloadSignal.aborted) return null
    const [tileX, tileY] = chunk.tile.split('/').map(Number)
    if (
      tileX === undefined ||
      tileY === undefined ||
      !Number.isInteger(tileX) ||
      !Number.isInteger(tileY)
    )
      return null
    const tileLeft = tileX * TILE_SIZE
    const tileRight = (tileX + 1) * TILE_SIZE
    const spanStart = wrapsX && tileLeft < template.bbox.maxX ? 0 : template.bbox.minX
    const spanEnd = wrapsX && tileLeft < template.bbox.maxX ? template.bbox.maxX : WORLD_PIXELS
    const left = Math.max(spanStart, tileLeft)
    const right = Math.min(wrapsX ? spanEnd : template.bbox.maxX, tileRight)
    const top = Math.max(template.bbox.minY, tileY * TILE_SIZE)
    const bottom = Math.min(template.bbox.maxY, (tileY + 1) * TILE_SIZE)
    const chunkWidth = right - left
    const chunkHeight = bottom - top
    if (chunkWidth <= 0 || chunkHeight <= 0) return null
    const bytes = await fetchChunkWithinBudget(
      server,
      chunk.hash,
      downloadSignal,
      MAX_TEMPLATE_TRANSFER_BYTES - encodedBytes,
    )
    if (bytes === null) return null
    encodedBytes += bytes.byteLength
    if (!declaresSize(bytes, chunkWidth, chunkHeight)) return null
    let decoded = decodedChunks.get(chunk.hash) ?? null
    if (decoded === null) {
      decoded = await decodeChunk(bytes, chunkWidth, chunkHeight)
      if (decoded === null) return null
      decodedChunks.set(chunk.hash, decoded)
    }

    for (let y = 0; y < chunkHeight; y++) {
      const targetY = top + y - template.bbox.minY
      if (targetY < 0 || targetY >= height) continue
      for (let x = 0; x < chunkWidth; x++) {
        const targetX =
          left >= template.bbox.minX
            ? left + x - template.bbox.minX
            : WORLD_PIXELS - template.bbox.minX + left + x
        if (targetX < 0 || targetX >= width) continue
        const index = decoded[y * chunkWidth + x] ?? TRANSPARENT_INDEX
        if (index === TRANSPARENT_INDEX) continue
        indices[targetY * width + targetX] = index
      }
    }
    placed++
  }
  if (placed !== template.chunks.length) return null
  return { width, height, indices }
}

const serverTemplateBelongsToSurface = (
  key: string,
  serverUrl: string,
  surface: TemplateSurface,
): boolean => {
  const prefix = serverTemplateIdPrefix(serverUrl)
  if (!key.startsWith(prefix)) return false
  const scopedId = key.slice(prefix.length)
  return surface.kind === 'world'
    ? !scopedId.startsWith('@')
    : scopedId.startsWith(`@${templateSurfaceKey(surface)}:`)
}

/** Templates already downloading, by the connection lifetime that started them. */
const inFlight = new PerServerMap<object>()

/**
 * Each template's newest manifest entry, and the connection it came through.
 *
 * A download that is already running is skipped rather than restarted, which is right — but the
 * manifest that arrives while it runs may have replaced or deleted that template, and installing
 * the finished download would then put back artwork nobody publishes any more. This is what the far
 * side of the download checks itself against, and what an evicted copy downloads again from.
 */
const latest = new PerServerMap<{
  readonly server: ConnectedServer
  readonly template: ServerTemplate
}>()

/**
 * Download a server template again, for a copy whose pixels were evicted and lost from disk.
 *
 * Only the version the newest manifest asked for, through the connection it came from.
 */
const downloadAgain = async (copy: ServerCopy): Promise<Uint8Array | null> => {
  const entry = latest.get(copy.server.url, copy.id)
  if (entry === undefined || entry.template.version !== copy.version) return null
  const { server } = entry
  const signal = AbortSignal.any([
    serverConnectionSignal(server),
    AbortSignal.timeout(MAX_TEMPLATE_ASSEMBLY_MS),
  ])
  const built = await assemblySlots.run(
    signal,
    async () => await assemble(server, entry.template, signal),
  )
  return built?.indices ?? null
}

const opaqueCount = (indices: Uint8Array): number =>
  indices.reduce((total, index) => (index === TRANSPARENT_INDEX ? total : total + 1), 0)

const serverTemplateRow = (
  server: ConnectedServer,
  template: ServerTemplate,
  key: string,
  surface: TemplateSurface,
  width: number,
  height: number,
) => ({
  id: key,
  surface,
  name: template.name,
  source: 'image' as const,
  originX: template.bbox.minX,
  originY: template.bbox.minY,
  width,
  height,
  // The server quantised on ingest, so nothing moved on the way here and every pixel it carries is
  // one it asserts.
  moved: 0,
  origin: 'server' as const,
  server,
  serverTemplateId: template.id,
  nodeId: template.nodeId,
  version: template.version,
  unpublished: !template.published,
  tileKeys: template.chunks.map((chunk) => chunk.tile),
  wrapX: surface.kind === 'world' && template.bbox.minX > template.bbox.maxX,
})

/**
 * Bring one server's templates on one surface onto the canvas, and take away what it no longer
 * has. Downloads belong to the connection lifetime: one that ends aborts them, so a reply landing
 * after a disconnect is dropped rather than drawn.
 *
 * Unpublished ones are drawn too, and the scope sorts that out by itself: the manifest only lists
 * them for an admin code, so a member never sees one and an admin sees exactly what they are about
 * to publish. Being able to look at a draft on the map before releasing it is the point of a draft.
 */
const syncServerTemplatesOnce = async (
  server: ConnectedServer,
  available: readonly ServerTemplate[],
  snapshotCurrent: () => boolean,
  surface: TemplateSurface,
): Promise<void> => {
  const signal = serverConnectionSignal(server)
  const lifetime = serverConnectionIdentity(server)
  const current = (): boolean =>
    isCurrentServerConnection(server) && !signal.aborted && snapshotCurrent()
  if (!current()) return
  const wanted = new Map(
    available
      .filter((template) =>
        sameTemplateSurface(template.surface ?? WORLD_TEMPLATE_SURFACE, surface),
      )
      .map((template) => [serverTemplateKey(server.url, template.id, surface), template]),
  )
  // Snapshot once. Re-reading and linearly searching the store for every manifest entry would make
  // a large server sync quadratic in the number of templates.
  const heldById = new Map(
    localTemplates()
      .filter((template): template is ServerCopy => template.origin === 'server')
      .map((template) => [template.id, template]),
  )

  for (const held of heldById.values()) {
    if (!current()) return
    if (held.server.url !== server.url) continue
    if (!sameTemplateSurface(held.surface, surface)) continue
    if (!wanted.has(held.id)) await forgetTemplateCopy(held.id)
  }
  if (!current()) return
  for (const [key, entry] of latest.entries(server.url)) {
    const onSurface = sameTemplateSurface(entry.template.surface ?? WORLD_TEMPLATE_SURFACE, surface)
    if (onSurface && !wanted.has(key)) latest.delete(server.url, key)
  }
  for (const [key, template] of wanted) latest.set(server.url, key, { server, template })
  // Cached pixels of templates this server stopped publishing while nobody was looking.
  void retainServerPixels(
    serverTemplateIdPrefix(server.url),
    (key) => wanted.has(key) || !serverTemplateBelongsToSurface(key, server.url, surface),
  )

  for (const [key, template] of wanted) {
    if (!current()) return
    const held = heldById.get(key)
    // The version is the whole point of the sync being cheap: same version, same pixels, nothing to
    // rebuild. Names and folder membership still arrive through the manifest because neither
    // changes the pixel version.
    if (held !== undefined && held.version === template.version) {
      const unpublishing = !template.published && !held.unpublished
      await updateServerTemplateMetadata(
        key,
        template.name,
        template.nodeId,
        !template.published,
        server,
      )
      // Masks saved while it was public describe it too. Cleared only once the row says draft, so
      // a request started in between cannot save another; any older one is fenced off here.
      if (unpublishing) invalidateServerMismatches(server.url)
      if (!current()) return
      continue
    }
    if (inFlight.get(server.url, key) === lifetime) continue
    // Asked before the download, not after. A server may advertise a template larger than memory
    // could ever hold, and decoding it only to have the store refuse it wastes the entire chunk
    // transfer and assembly on every poll.
    const wrapsX = surface.kind === 'world' && template.bbox.minX > template.bbox.maxX
    const width = wrapsX
      ? WORLD_PIXELS - template.bbox.minX + template.bbox.maxX
      : template.bbox.maxX - template.bbox.minX
    const height = template.bbox.maxY - template.bbox.minY
    const pixels = width * height
    if (!Number.isSafeInteger(pixels) || pixels <= 0 || !hasRoomForCopy(key, pixels)) {
      continue
    }
    inFlight.set(server.url, key, lifetime)
    const latestVersion = (): string | undefined => latest.get(server.url, key)?.template.version
    const stillWanted = (): boolean => current() && latestVersion() === template.version
    // A draft keeps no saved masks, including ones a public copy saved in an earlier session.
    const wasPublic = !template.published && held?.unpublished !== true
    try {
      // Cached at this version: install without downloading, and read the pixels when needed.
      const cached = await cachedServerCopy(key, template.version)
      if (!current()) return
      if (cached !== null) {
        const row = serverTemplateRow(server, template, key, surface, width, height)
        const copy = { ...row, indices: null, opaque: cached.opaque, cachedArea: cached.area }
        if (!(await putTemplateCopy(copy, stillWanted))) return
        count('server:template restored from disk')
        continue
      }
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(MAX_TEMPLATE_ASSEMBLY_MS)])
      const outcome = await assemblySlots.run(
        attemptSignal,
        async (): Promise<'continue' | 'stop'> => {
          const built = await assemble(server, template, attemptSignal)
          if (built === null) return 'continue'
          if (attemptSignal.aborted) return 'continue'
          // The connection this download belongs to may have ended, or a later manifest may have
          // taken over this template, while the chunks were in the air.
          if (!current()) return 'stop'
          // A newer manifest landed while the chunks were in the air, and it no longer asks for this
          // version — or no longer asks for this template at all. Installing now would draw artwork
          // that has already been replaced, or bring a deleted overlay back.
          if (latestVersion() !== template.version) return 'continue'
          if (!hasRoomForCopy(key, built.indices.length)) return 'continue'
          // Hold the shared assembly slot through persistence so its decoded buffer cannot pile up
          // behind other completed assemblies while the store is busy.
          const installed = await putTemplateCopy(
            {
              ...serverTemplateRow(server, template, key, surface, built.width, built.height),
              indices: built.indices,
              opaque: opaqueCount(built.indices),
            },
            stillWanted,
          )
          if (!installed) return 'stop'
          count('server:template drawn from chunks')
          return 'continue'
        },
      )
      if (outcome === undefined) continue
      if (outcome === 'stop') return
    } catch (error) {
      warn(`could not sync server template ${template.name}`, String(error))
    } finally {
      if (inFlight.get(server.url, key) === lifetime) inFlight.delete(server.url, key)
      // After the install, so the row already says draft: a public row of an older version may
      // have requests in flight, which only a server-wide invalidation fences.
      if (wasPublic) {
        if (held === undefined) void deleteCachedServerMismatches(server.url, template.id)
        else invalidateServerMismatches(server.url)
      }
    }
  }
}

interface PendingServerSync {
  readonly server: ConnectedServer
  readonly templates: readonly ServerTemplate[]
  readonly current: () => boolean
  readonly surface: TemplateSurface
}

/** The newest admitted manifest per server and surface, waiting for the running drain. */
const pendingServerSyncs = new PerServerMap<PendingServerSync>()
/** The drain per server and surface, and the connection lifetime it belongs to. */
const serverSyncRuns = new PerServerMap<{
  readonly lifetime: object
  readonly done: Promise<void>
}>()

const ensureServerSyncRun = (serverUrl: string, key: string): Promise<void> => {
  const requested = pendingServerSyncs.get(serverUrl, key)
  const existing = serverSyncRuns.get(serverUrl, key)
  // A new connection must not queue behind an obsolete drain. The old run's release is identity
  // guarded, so it cannot delete the replacement when it eventually settles.
  if (
    existing !== undefined &&
    (requested === undefined || serverConnectionIdentity(requested.server) === existing.lifetime)
  )
    return existing.done
  if (requested === undefined) return Promise.resolve()
  const lifetime = serverConnectionIdentity(requested.server)
  const done = (async () => {
    while (true) {
      const next = pendingServerSyncs.get(serverUrl, key)
      if (next === undefined || serverConnectionIdentity(next.server) !== lifetime) return
      pendingServerSyncs.delete(serverUrl, key)
      await syncServerTemplatesOnce(next.server, next.templates, next.current, next.surface)
    }
  })()
  const run = { lifetime, done }
  serverSyncRuns.set(serverUrl, key, run)
  const release = (): void => {
    if (serverSyncRuns.get(serverUrl, key) === run) serverSyncRuns.delete(serverUrl, key)
  }
  void done.then(release, release)
  return done
}

/** Wait until the canvas holds every manifest already queued for this server and surface. */
export const serverTemplatesSettled = async (
  server: ServerConnection,
  surface: TemplateSurface,
): Promise<void> => {
  const key = templateSurfaceKey(surface)
  while (pendingServerSyncs.has(server.url, key) || serverSyncRuns.has(server.url, key))
    await ensureServerSyncRun(server.url, key)
}

/**
 * Bring one server up to date with an admitted manifest, coalescing any that arrive while its
 * current download runs. The newest manifest wins, and at most one assembly per server and surface
 * can own network, decode, and bitmap memory at a time.
 */
const syncServerTemplates = (
  server: ServerConnection,
  templates: readonly ServerTemplate[],
  current: () => boolean,
  surface: TemplateSurface,
): void => {
  // Immutable state rows may change cosmetic server metadata in place. Credentials, deployment,
  // season, scope, and connectivity define the lifetime that is allowed to continue this work.
  if (!isConnected(server) || !isCurrentServerConnection(server) || !current()) return
  pendingServerSyncs.set(server.url, templateSurfaceKey(surface), {
    server,
    templates,
    current,
    surface,
  })
  void serverTemplatesSettled(server, surface)
}

// Every admitted manifest reaches the canvas, whichever read, poll or event brought it in.
onManifestChange((server, surface, change) => {
  if (change.status === 'admitted')
    syncServerTemplates(server, change.contents.templates, change.current, surface)
})

// A disconnected server's downloads land stale rather than drawing an overlay with no server row
// left to control it, and the overlays it already drew go with it. The chunk caches are
// content-addressed and cannot tell whose bytes are whose; the manifest entries are the last thing
// that knows, so they hand their hashes over on the way out.
onServerRemoved(async (serverUrl) => {
  pendingServerSyncs.forget(serverUrl)
  serverSyncRuns.forget(serverUrl)
  inFlight.forget(serverUrl)
  for (const { template } of latest.forget(serverUrl).values())
    for (const chunk of template.chunks) {
      chunkCache.delete(chunk.hash)
      decodedChunks.delete(chunk.hash)
    }
  await forgetTemplateCopies((copy) => copy.origin === 'server' && copy.server.url === serverUrl)
})

/**
 * Keep every connected server's world templates on the canvas.
 *
 * The shared coordinator supplies the compatibility cadence; admitted manifests reach the canvas
 * through the manifest store, so the tree, canvas, telemetry coverage, and revision schedule all
 * use the same response.
 */
export const installServerSync = (): void => {
  setServerPixelSource(downloadAgain)
  registerServerSyncResource({
    id: 'world-manifest',
    live: true,
    reconcileOnManifestEvent: true,
    scope: () => 'world',
    refresh: async (server, reason, transport) => {
      const contents = await readManifest(server, { reason, transport })
      if (contents === null) return { status: 'failed' }
      return contents.revision === undefined
        ? { status: 'unchanged' }
        : { status: 'unchanged', revision: contents.revision }
    },
    applyLiveEvent: async (server, event) => {
      if (event.type !== 'manifest-snapshot' || event.scope !== 'world') return false
      if (applyLiveManifest(server, WORLD_TEMPLATE_SURFACE, event.manifest) === null) return false
      await serverTemplatesSettled(server, WORLD_TEMPLATE_SURFACE)
      return true
    },
  })
  /**
   * A newly connected server starts from the manifest its probe already downloaded. Its revision
   * is applied before the live socket opens, so the socket's state vector names the version this
   * client holds and the server does not send the same manifest again.
   */
  onStateChange(() => {
    for (const server of connectedServers()) {
      const contents = adoptProbedManifest(server)
      if (contents?.revision !== undefined && isCurrentServerConnection(server))
        applyServerSyncRevision(server, 'world', 'world-manifest', contents.revision)
    }
  })
}
