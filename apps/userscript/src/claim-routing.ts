import {
  REGION_CLAIM_TTL_MS,
  type RegionClaim,
  type RegionDocument,
  type RegionShapePixels,
  rectIntersection,
  regionDocumentBounds,
  regionDocumentPixels,
  sameTemplateSurface,
  uuidV7,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { onServerSnapshot, rowsForSurface } from './application/tree-server-state.js'
import { warn } from './debug.js'
import {
  claimRegion,
  isPresenceRegion,
  onPresenceClaimsChange,
  presenceServerClaims,
  presenceServers,
  releaseRegion,
} from './presence-client.js'
import type { ServerTemplate } from './server-cache.js'
import { type ConnectedServer, onStateChange, serverConnectionIdentity } from './state.js'
import { accountIdentity } from './wplace-account.js'

const pixelCache = new WeakMap<RegionDocument, RegionShapePixels | null>()
const STORAGE_KEY = 'caelestis.region-claims.v1'
const RETRY_MS = 30_000
const DISCONNECT_MS = 3_000
interface Copy {
  readonly url: string
  readonly serverId: string
}
interface Entry {
  region: RegionClaim
  deleted: boolean
  copies: Copy[]
}

/** Raster overlap respects subtractors and gaps between shapes, plus world-wrapping templates. */
const overlaps = (pixels: RegionShapePixels, template: ServerTemplate): boolean => {
  const { minX, minY, maxX, maxY } = template.bbox
  const spans =
    minX < maxX
      ? [[minX, maxX]]
      : [
          [minX, WORLD_PIXELS],
          [0, maxX],
        ]
  return spans.some(([left = 0, right = 0]) => {
    const clip = rectIntersection(pixels.rect, {
      x: left,
      y: minY,
      w: right - left,
      h: maxY - minY,
    })
    if (clip === null) return false
    for (let y = clip.y; y < clip.y + clip.h; y++) {
      const offset = (y - pixels.rect.y) * pixels.rect.w
      for (let x = clip.x; x < clip.x + clip.w; x++)
        if (pixels.mask[offset + x - pixels.rect.x] === 1) return true
    }
    return false
  })
}

/** Eligible recipients and a template hint per copy; null means a catalog is still loading. */
export const claimRecipients = (
  region: RegionClaim,
  servers: readonly ConnectedServer[],
  templates: (
    server: ConnectedServer,
    region: RegionClaim,
  ) => readonly ServerTemplate[] | undefined,
): Map<ConnectedServer, string | null> | null => {
  const candidates = servers.filter((server) => server.season === region.season)
  let pixels = pixelCache.get(region.document)
  if (pixels === undefined) {
    pixels = regionDocumentPixels(region.document)
    pixelCache.set(region.document, pixels)
  }
  if (pixels === null) return new Map()
  const matching = new Map<ConnectedServer, string | null>()
  for (const server of candidates) {
    const rows = templates(server, region)
    if (rows === undefined) return null
    const match = rows.find(
      (template) =>
        sameTemplateSurface(template.surface ?? WORLD_TEMPLATE_SURFACE, region.surface) &&
        overlaps(pixels, template),
    )
    if (match !== undefined) matching.set(server, match.id)
  }
  return matching.size > 0 ? matching : new Map(candidates.map((server) => [server, null]))
}

interface RoutingHost {
  servers(): readonly ConnectedServer[]
  templates(server: ConnectedServer, region: RegionClaim): readonly ServerTemplate[] | undefined
  claims(server: ConnectedServer): {
    readonly ready: boolean
    readonly regions: readonly RegionClaim[]
  }
  actor(): ReturnType<typeof accountIdentity>
  persist(entries: readonly Entry[]): void
  put(server: ConnectedServer, region: RegionClaim, signal: AbortSignal): Promise<string | null>
  remove(server: ConnectedServer, region: RegionClaim, signal: AbortSignal): Promise<string | null>
}

/** Durable claim intent with serialized reconciliation and retryable per-server copies. */
export class ClaimRouter {
  private readonly entries = new Map<string, Entry>()
  private readonly receipts = new WeakMap<object, Map<string, string>>()
  private readonly retiring = new Set<object>()
  private readonly inFlight = new Map<object, Promise<string | null>>()
  private draftId: string | null = null
  private readonly requests = new Map<object, AbortController>()
  private pending: Promise<void> = Promise.resolve()
  private wanted = false
  private readonly errors = new Map<string, string>()
  private readonly failedServers = new Map<object, string>()

  constructor(
    private readonly host: RoutingHost,
    saved: readonly Entry[] = [],
  ) {
    for (const entry of saved) this.entries.set(entry.region.id, entry)
    this.prune()
  }

  /** Refresh shared intent while the browser-wide mutation lock is held. */
  restore(saved: readonly Entry[]): void {
    this.entries.clear()
    for (const entry of saved) this.entries.set(entry.region.id, entry)
    this.prune()
  }

  private prune(): void {
    for (const [id, entry] of this.entries)
      if ((entry.region.expiresAt ?? entry.region.createdAt + REGION_CLAIM_TTL_MS) <= Date.now())
        this.entries.delete(id)
  }

  /** The current painter's unexpired logical claims, including pending deliveries. */
  mine(): readonly RegionClaim[] {
    this.prune()
    return [...this.entries.values()]
      .filter(
        (entry) =>
          !entry.deleted && entry.region.claimant.wplaceUserId === this.host.actor()?.wplaceUserId,
      )
      .map((entry) => entry.region)
  }

  /** Persist before sending so failures and reloads retain the same logical ID. */
  async save(id: string | null, document: RegionDocument): Promise<string | null> {
    const actor = this.host.actor()
    if (actor === null) return 'Sign in to Wplace to claim regions.'
    id ??= this.draftId
    const existing = id === null ? undefined : this.entries.get(id)
    if (
      id !== null &&
      (existing === undefined || existing.region.claimant.wplaceUserId !== actor.wplaceUserId)
    )
      return 'That claim is no longer available.'
    const seasons = new Set(this.host.servers().map((server) => server.season))
    const season = existing?.region.season ?? (seasons.size === 1 ? [...seasons][0] : null)
    if (season == null) return 'Connect servers for the same season, then retry.'
    const rect = regionDocumentBounds(document)
    if (rect === null) return 'Draw a region first.'
    const region: RegionClaim = {
      id: id ?? uuidV7(),
      season,
      surface: existing?.region.surface ?? WORLD_TEMPLATE_SURFACE,
      templateId: null,
      document,
      rect,
      claimant: actor,
      label: '',
      createdAt: existing?.region.createdAt ?? Date.now(),
      expiresAt: Date.now() + REGION_CLAIM_TTL_MS,
    }
    if (id === null) this.draftId = region.id
    const previous = this.entries.get(region.id)
    this.entries.set(region.id, { region, deleted: false, copies: previous?.copies ?? [] })
    try {
      this.persist()
    } catch (error) {
      if (previous === undefined) this.entries.delete(region.id)
      else this.entries.set(region.id, previous)
      return `Could not save claims: ${String(error)}`
    }
    await this.reconcile()
    const error = this.errors.get(region.id) ?? null
    if (error === null) this.draftId = null
    return error
  }

  /** Keep a tombstone until old copies can be removed or their TTL expires. */
  async remove(id: string): Promise<string | null> {
    const entry = this.entries.get(id)
    if (
      entry === undefined ||
      entry.region.claimant.wplaceUserId !== this.host.actor()?.wplaceUserId
    )
      return 'That claim is no longer available.'
    entry.deleted = true
    try {
      this.persist()
    } catch (error) {
      entry.deleted = false
      return `Could not save deletion: ${String(error)}`
    }
    await this.reconcile()
    return this.errors.get(id) ?? null
  }

  private persist(): void {
    this.host.persist([...this.entries.values()])
  }
  private servers(): readonly ConnectedServer[] {
    return this.host
      .servers()
      .filter((server) => !this.retiring.has(serverConnectionIdentity(server)))
  }

  /** Coalesce changes while writes run; retries use the latest saved document. */
  reconcile(): Promise<void> {
    this.wanted = true
    this.pending = this.pending
      .then(async () => {
        while (this.wanted) {
          this.wanted = false
          await this.sync()
        }
      })
      .catch((error: unknown) => {
        for (const entry of this.entries.values()) this.errors.set(entry.region.id, String(error))
        warn('install', 'claim reconciliation failed', String(error))
      })
    return this.pending
  }

  private async sync(): Promise<void> {
    this.failedServers.clear()
    this.prune()
    const actor = this.host.actor()
    if (actor === null) return
    const servers = this.servers()
    for (const server of servers) {
      const received = this.host.claims(server)
      if (!received.ready) continue
      for (const region of received.regions) {
        if (
          region.claimant.wplaceUserId !== actor.wplaceUserId ||
          (region.expiresAt ?? region.createdAt + REGION_CLAIM_TTL_MS) <= Date.now()
        )
          continue
        let entry = this.entries.get(region.id)
        if (entry === undefined) {
          entry = { region, deleted: false, copies: [] }
          this.entries.set(region.id, entry)
        }
        this.rememberCopy(entry, server)
        if (
          !entry.deleted &&
          region.expiresAt !== undefined &&
          region.expiresAt > (entry.region.expiresAt ?? 0)
        )
          entry.region = { ...entry.region, expiresAt: region.expiresAt }
      }
    }
    this.persist()
    for (const entry of this.entries.values()) {
      if (entry.region.claimant.wplaceUserId !== actor.wplaceUserId) continue
      this.errors.delete(entry.region.id)
      const recipients = entry.deleted
        ? new Map<ConnectedServer, string | null>()
        : claimRecipients(entry.region, servers, this.host.templates)
      if (recipients === null) {
        this.errors.set(
          entry.region.id,
          'Server templates are still loading. The claim will retry.',
        )
        continue
      }
      if (!entry.deleted && recipients.size === 0) {
        this.errors.set(entry.region.id, 'No compatible server is connected. The claim will retry.')
        continue
      }
      const puts = await Promise.all(
        [...recipients].map(([server, templateId]) =>
          this.write(entry, server, { ...entry.region, templateId }),
        ),
      )
      // Keep old copies until every new recipient has accepted its replacement.
      if (puts.some((ok) => !ok)) continue
      await Promise.all(
        servers
          .filter((server) => !recipients.has(server) && this.hasCopy(entry, server))
          .map((server) => this.write(entry, server, null)),
      )
    }
    this.persist()
  }

  private hasCopy(entry: Entry, server: ConnectedServer): boolean {
    return entry.copies.some((copy) => copy.url === server.url && copy.serverId === server.info?.id)
  }
  private rememberCopy(entry: Entry, server: ConnectedServer): void {
    if (!this.hasCopy(entry, server) && server.info !== null)
      entry.copies.push({ url: server.url, serverId: server.info.id })
  }

  private async write(
    entry: Entry,
    server: ConnectedServer,
    region: RegionClaim | null,
  ): Promise<boolean> {
    const owner = serverConnectionIdentity(server)
    if (this.retiring.has(owner)) return false
    const previousFailure = this.failedServers.get(owner)
    if (previousFailure !== undefined) {
      this.errors.set(entry.region.id, previousFailure)
      return false
    }
    const signature =
      region === null
        ? 'deleted'
        : JSON.stringify([region.document, region.label, region.templateId])
    let receipts = this.receipts.get(owner)
    if (receipts === undefined) {
      receipts = new Map()
      this.receipts.set(owner, receipts)
    }
    if (receipts.get(entry.region.id) === signature) return true
    if (region !== null) {
      this.rememberCopy(entry, server)
      this.persist()
    }
    const controller = new AbortController()
    this.requests.set(owner, controller)
    const work =
      region === null
        ? this.host.remove(server, entry.region, controller.signal)
        : this.host.put(server, region, controller.signal)
    this.inFlight.set(owner, work)
    const error = await work
    this.inFlight.delete(owner)
    this.requests.delete(owner)
    if (error !== null) {
      const message = `${server.info?.name ?? server.url}: ${error}`
      this.errors.set(entry.region.id, message)
      this.failedServers.set(owner, message)
      return false
    }
    receipts.set(entry.region.id, signature)
    if (region === null)
      entry.copies = entry.copies.filter(
        (copy) => !(copy.url === server.url && copy.serverId === server.info?.id),
      )
    return true
  }

  /** Stop new writes and attempt only this painter's cleanup within a fixed disconnect deadline. */
  async disconnect(server: ConnectedServer): Promise<void> {
    const owner = serverConnectionIdentity(server)
    this.retiring.add(owner)
    this.requests.get(owner)?.abort()
    const actor = this.host.actor()
    const regions = new Map(
      this.host
        .claims(server)
        .regions.filter((region) => region.claimant.wplaceUserId === actor?.wplaceUserId)
        .map((region) => [region.id, region]),
    )
    for (const entry of this.entries.values())
      if (entry.region.claimant.wplaceUserId === actor?.wplaceUserId && this.hasCopy(entry, server))
        regions.set(entry.region.id, entry.region)
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort()
        resolve()
      }, DISCONNECT_MS)
    })
    const cleanup = (this.inFlight.get(owner) ?? Promise.resolve()).then(() => {
      if (controller.signal.aborted) return
      return Promise.all(
        [...regions.values()].map(async (region) => {
          const error = await this.host.remove(server, region, controller.signal)
          if (error !== null) warn('install', 'claim disconnect cleanup failed', error)
        }),
      ).then(() => undefined)
    })
    try {
      await Promise.race([cleanup, deadline])
    } finally {
      clearTimeout(timeout)
    }
  }
}

const manager = globalThis as typeof globalThis & {
  GM_getValue?: (key: string, fallback: string) => string
  GM_setValue?: (key: string, value: string) => void
}
const load = (): Entry[] => {
  try {
    const raw: unknown = JSON.parse(
      manager.GM_getValue?.(STORAGE_KEY, '[]') ?? localStorage.getItem(STORAGE_KEY) ?? '[]',
    )
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (entry): entry is Entry =>
        typeof entry === 'object' &&
        entry !== null &&
        isPresenceRegion(entry.region) &&
        typeof entry.deleted === 'boolean' &&
        Array.isArray(entry.copies) &&
        entry.copies.every(
          (copy: unknown) =>
            typeof copy === 'object' &&
            copy !== null &&
            'url' in copy &&
            typeof copy.url === 'string' &&
            'serverId' in copy &&
            typeof copy.serverId === 'string',
        ),
    )
  } catch (error) {
    warn('install', 'could not load claims', String(error))
    return []
  }
}

let router: ClaimRouter | undefined
const localRouter = (): ClaimRouter =>
  (router ??= new ClaimRouter(
    {
      servers: presenceServers,
      templates: (server, region) => rowsForSurface(server, region.surface)?.templates,
      claims: presenceServerClaims,
      actor: accountIdentity,
      persist: (entries) => {
        const raw = JSON.stringify(entries)
        if (manager.GM_setValue !== undefined) manager.GM_setValue(STORAGE_KEY, raw)
        else localStorage.setItem(STORAGE_KEY, raw)
      },
      put: (server, region, signal) =>
        claimRegion(
          server,
          region.id,
          {
            document: region.document,
            templateId: region.templateId,
            label: region.label,
            actor: region.claimant,
          },
          region,
          signal,
        ),
      remove: (server, region, signal) =>
        releaseRegion(server, region.id, region.claimant, region, signal),
    },
    load(),
  ))

let pendingOperation: Promise<unknown> = Promise.resolve()
const withClaims = <T>(operation: (router: ClaimRouter) => Promise<T>): Promise<T> => {
  const run = () => {
    const router = localRouter()
    router.restore(load())
    return operation(router)
  }
  const next = pendingOperation.then(() =>
    typeof navigator !== 'undefined' && navigator.locks !== undefined
      ? navigator.locks.request(STORAGE_KEY, run)
      : run(),
  )
  pendingOperation = next.catch(() => undefined)
  return next
}
let pendingReconciliation: Promise<void> | null = null
const operations = {
  mine: () =>
    load()
      .filter(
        (entry) =>
          !entry.deleted &&
          entry.region.claimant.wplaceUserId === accountIdentity()?.wplaceUserId &&
          (entry.region.expiresAt ?? entry.region.createdAt + REGION_CLAIM_TTL_MS) > Date.now(),
      )
      .map((entry) => entry.region),
  save: (id: string | null, document: RegionDocument) =>
    withClaims((router) => router.save(id, document)),
  remove: (id: string) => withClaims((router) => router.remove(id)),
  reconcile: () =>
    (pendingReconciliation ??= withClaims((router) => router.reconcile()).finally(() => {
      pendingReconciliation = null
    })),
  // Disconnection must retain its deadline even if another tab holds the mutation lock.
  disconnect: (server: ConnectedServer) => localRouter().disconnect(server),
}

/** Share claim intent across tabs; one browser-wide writer reconciles it at a time. */
export const claimRouter = () => operations

/** Reconcile on catalog/connection changes and retry partial failures while the page remains open. */
export const installClaimRouting = (): void => {
  const reconcile = () => {
    void claimRouter().reconcile()
  }
  onPresenceClaimsChange(reconcile)
  onStateChange(reconcile)
  onServerSnapshot(reconcile)
  setInterval(reconcile, RETRY_MS)
  reconcile()
}
