import {
  claimDocumentError,
  claimDocumentPixels,
  claimDocumentsLimitError,
  claimExpiry,
  isRegionClaim,
  isRegionDocument,
  type PresenceRect,
  REGION_CLAIM_TTL_MS,
  type RegionClaim,
  type RegionDocument,
  type RegionShapePixels,
  rectIntersection,
  regionDocumentBounds,
  reuseDocument,
  sameDocument,
  sameTemplateSurface,
  uuidV7,
  WORLD_PIXELS,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { onServerSnapshot } from './application/tree-server-state.js'
import { canWriteClaims, claimServers, onClaimsChange, serverClaims } from './claim-store.js'
import { warn } from './debug.js'
import { claimRegion, type RegionWriteResult, releaseRegion } from './region-api.js'
import {
  onServerConnected,
  onServerRemoving,
  serverConnectionIdentity,
} from './server-connections.js'
import type { ServerTemplate } from './server-manifest.js'
import { manifestRows } from './server-manifests.js'
import { onStateChange, type ServerConnection } from './settings.js'
import { storedValue, storeValue, syncStoredValues } from './stored-values.js'
import { accountIdentity } from './wplace-account.js'

const STORAGE_KEY = 'caelestis.region-claims.v1'
/** How long a failed delivery waits before the router tries again on its own. */
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
  replaceAfter?: readonly string[]
}

export interface ClaimSaveResult {
  readonly ids: readonly string[]
  readonly error: string | null
}

const isCopy = (value: unknown): value is Copy =>
  typeof value === 'object' &&
  value !== null &&
  'url' in value &&
  typeof value.url === 'string' &&
  'serverId' in value &&
  typeof value.serverId === 'string'

/** One stored journal entry, checked before routing trusts it. */
const isEntry = (value: unknown): value is Entry => {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Entry
  return (
    isRegionClaim(entry.region) &&
    typeof entry.deleted === 'boolean' &&
    (entry.replaceAfter === undefined ||
      (Array.isArray(entry.replaceAfter) &&
        entry.replaceAfter.every((id: unknown) => typeof id === 'string'))) &&
    Array.isArray(entry.copies) &&
    entry.copies.every(isCopy)
  )
}

const isCopyOn = (copy: Copy, server: ServerConnection): boolean =>
  copy.url === server.url && copy.serverId === server.info?.id

/** Whether an entry is a live claim rather than a deletion or a record awaiting replacement. */
const isLive = (entry: Entry): boolean => !entry.deleted && entry.replaceAfter === undefined

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

/**
 * The servers a claim goes to, each with the template it overlaps there as a hint. Null while a
 * catalog is still loading. With no overlap anywhere, every server of the claim's season gets it.
 */
const claimRecipients = (
  region: RegionClaim,
  servers: readonly ServerConnection[],
  templates: (
    server: ServerConnection,
    region: RegionClaim,
  ) => readonly ServerTemplate[] | undefined,
): Map<ServerConnection, string | null> | null => {
  const candidates = servers.filter((server) => server.season === region.season)
  const pixels = claimDocumentPixels(region.document)
  if (pixels === null) return new Map()
  const matching = new Map<ServerConnection, string | null>()
  for (const server of candidates) {
    const rows = templates(server, region)
    if (rows === undefined) return null
    const match = rows.find(
      (template) =>
        sameTemplateSurface(template.surface, region.surface) && overlaps(pixels, template),
    )
    if (match !== undefined) matching.set(server, match.id)
  }
  return matching.size > 0 ? matching : new Map(candidates.map((server) => [server, null]))
}

/** What the router needs from the page: servers, their claims, storage, and the claim API. */
interface RoutingHost {
  /** Servers that accept claim writes. */
  servers(): readonly ServerConnection[]
  templates(server: ServerConnection, region: RegionClaim): readonly ServerTemplate[] | undefined
  claims(server: ServerConnection): {
    readonly ready: boolean
    readonly regions: readonly RegionClaim[]
    readonly revision?: number
    readonly ownedRegionIds?: readonly string[]
  }
  actor(): ReturnType<typeof accountIdentity>
  persist(entries: readonly Entry[]): void
  /** The journal as stored now, which another tab may have written since. */
  saved(): readonly Entry[]
  retired(server: ServerConnection): boolean
  retire(server: ServerConnection): void
  put(
    server: ServerConnection,
    region: RegionClaim,
    signal: AbortSignal,
  ): Promise<RegionWriteResult>
  remove(
    server: ServerConnection,
    region: RegionClaim,
    signal: AbortSignal,
    withdraw: boolean,
  ): Promise<RegionWriteResult>
}

/** Durable claim intent with serialized reconciliation and retryable per-server copies. */
export class ClaimRouter {
  private readonly entries = new Map<string, Entry>()
  private readonly receipts = new WeakMap<object, Map<string, string>>()
  private readonly snapshots = new WeakMap<object, number>()
  private readonly retiring = new Set<object>()
  private readonly inFlight = new Map<object, Promise<RegionWriteResult>>()
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

  /** Whether some delivery failed and is worth trying again later. */
  get failing(): boolean {
    return this.errors.size > 0
  }

  /**
   * Refresh shared intent while the browser-wide mutation lock is held. A claim whose document is
   * unchanged keeps the document object it had, so its cached raster survives the reload.
   */
  restore(saved: readonly Entry[]): void {
    const previous = new Map(this.entries)
    this.entries.clear()
    for (const entry of saved)
      this.entries.set(entry.region.id, {
        ...entry,
        region: reuseDocument(previous.get(entry.region.id)?.region, entry.region),
      })
    this.prune()
  }

  private prune(): void {
    for (const [id, entry] of this.entries)
      if (claimExpiry(entry.region) <= Date.now() && (isLive(entry) || entry.copies.length === 0))
        this.entries.delete(id)
  }

  /**
   * Persist the whole set of this painter's claims before sending, so failures and reloads keep
   * the same logical ids. Each document keeps the id of a loaded claim it matches; loaded claims
   * with nothing left are released once every replacement is accepted.
   */
  async saveAll(
    ids: readonly string[],
    documents: readonly RegionDocument[],
  ): Promise<ClaimSaveResult> {
    const fail = (error: string): ClaimSaveResult => ({ ids, error })
    const actor = this.host.actor()
    if (actor === null) return fail('Sign in to Wplace to claim regions.')
    const previous: Entry[] = []
    for (const id of new Set(ids)) {
      const entry = this.entries.get(id)
      if (entry === undefined || entry.region.claimant.wplaceUserId !== actor.wplaceUserId)
        return fail('That claim is no longer available.')
      previous.push(entry)
    }
    const limitError = claimDocumentsLimitError(documents)
    if (limitError !== null) return fail(limitError)
    for (const document of documents) {
      if (!isRegionDocument(document)) return fail('Invalid region document')
      const error = claimDocumentError(document)
      if (error !== null) return fail(error)
    }
    const seasons = new Set(
      previous.length > 0
        ? previous.map(({ region }) => region.season)
        : this.servers().map((server) => server.season),
    )
    const season = seasons.size === 1 ? [...seasons][0] : undefined
    if (documents.length > 0 && season === undefined)
      return fail('Connect servers for the same season, then retry.')
    const surface = previous[0]?.region.surface ?? WORLD_TEMPLATE_SURFACE
    if (previous.some(({ region }) => !sameTemplateSurface(region.surface, surface)))
      return fail('That claim is no longer available.')
    const unused = new Set(previous.filter(isLive))
    const matched = documents.map((document) => {
      const exact = [...unused].find(({ region }) => sameDocument(region.document, document))
      if (exact !== undefined) {
        unused.delete(exact)
        return { document, existing: exact }
      }
      const itemIds = new Set(document.items.map((item) => item.id))
      const existing = [...unused].find(({ region }) =>
        region.document.items.some((item) => itemIds.has(item.id)),
      )
      return { document, existing }
    })
    // A record that splits into several keeps its id for none of them: overwriting it with one
    // piece before the others land would shrink the remote claim if a later write failed. The
    // pieces take fresh ids and the source stays whole until they are all accepted.
    const claims = new Map<Entry, number>()
    for (const { existing } of matched)
      if (existing !== undefined) claims.set(existing, (claims.get(existing) ?? 0) + 1)
    const held = new Map(this.entries)
    const nextIds: string[] = []
    for (const { document, existing: candidate } of matched) {
      const existing =
        candidate !== undefined && claims.get(candidate) === 1 ? candidate : undefined
      const now = Date.now()
      const region: RegionClaim = {
        id: existing?.region.id ?? uuidV7(),
        season: season as number,
        surface,
        templateId: null,
        document,
        rect: regionDocumentBounds(document) as PresenceRect,
        claimant: actor,
        label: existing?.region.label ?? '',
        createdAt: existing?.region.createdAt ?? now,
        expiresAt:
          existing === undefined ? now + REGION_CLAIM_TTL_MS : claimExpiry(existing.region),
      }
      nextIds.push(region.id)
      this.entries.set(region.id, { region, deleted: false, copies: existing?.copies ?? [] })
    }
    const obsolete = previous.map(({ region }) => region.id).filter((id) => !nextIds.includes(id))
    const pendingIds = [...nextIds, ...obsolete]
    for (const id of obsolete) {
      const entry = this.entries.get(id) as Entry
      this.entries.set(id, { ...entry, replaceAfter: nextIds })
    }
    try {
      this.persist()
    } catch (error) {
      this.entries.clear()
      for (const [id, entry] of held) this.entries.set(id, entry)
      return fail(`Could not save claims: ${String(error)}`)
    }
    await this.reconcile()
    const error =
      pendingIds.map((id) => this.errors.get(id)).find((error) => error !== undefined) ?? null
    return { ids: error === null ? nextIds : pendingIds, error }
  }

  /** Clear this painter's claim across tokens without adopting foreign credentials for replication. */
  async remove(id: string): Promise<string | null> {
    const previous = this.entries.get(id)
    const region =
      previous?.region ??
      this.servers()
        .flatMap((server) => this.host.claims(server).regions)
        .find((region) => region.id === id)
    if (region === undefined || region.claimant.wplaceUserId !== this.host.actor()?.wplaceUserId)
      return 'That claim is no longer available.'
    const entry: Entry = { region, deleted: true, copies: [...(previous?.copies ?? [])] }
    for (const server of this.servers())
      if (this.host.claims(server).regions.some((region) => region.id === id))
        this.rememberCopy(entry, server)
    this.entries.set(id, entry)
    try {
      this.persist()
    } catch (error) {
      if (previous === undefined) this.entries.delete(id)
      else this.entries.set(id, previous)
      return `Could not save deletion: ${String(error)}`
    }
    await this.reconcile()
    return this.errors.get(id) ?? null
  }

  private persist(): void {
    this.host.persist([...this.entries.values()])
  }

  private servers(): readonly ServerConnection[] {
    return this.host
      .servers()
      .filter(
        (server) =>
          !this.host.retired(server) && !this.retiring.has(serverConnectionIdentity(server)),
      )
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
        warn('claim reconciliation failed', String(error))
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
      const owner = serverConnectionIdentity(server)
      if (received.revision !== undefined && this.snapshots.get(owner) !== received.revision) {
        this.snapshots.set(owner, received.revision)
        const receipts = this.receipts.get(owner)
        for (const [id, signature] of receipts ?? []) {
          const region = received.regions.find((region) => region.id === id)
          if (
            signature === 'deleted' || signature === 'withdrawn'
              ? region !== undefined
              : region === undefined || writeSignature(region) !== signature
          )
            receipts?.delete(id)
        }
      }
      for (const region of received.regions) {
        if (
          region.claimant.wplaceUserId !== actor.wplaceUserId ||
          !received.ownedRegionIds?.includes(region.id) ||
          claimExpiry(region) <= Date.now()
        )
          continue
        let entry = this.entries.get(region.id)
        if (entry === undefined) {
          entry = { region, deleted: false, copies: [] }
          this.entries.set(region.id, entry)
        }
        this.rememberCopy(entry, server)
        if (region.expiresAt !== undefined && region.expiresAt > (entry.region.expiresAt ?? 0))
          entry.region = { ...entry.region, expiresAt: region.expiresAt }
      }
    }
    this.persist()
    const entries = [...this.entries.values()].sort(
      (a, b) => Number(!isLive(a)) - Number(!isLive(b)),
    )
    for (const entry of entries) {
      if (entry.region.claimant.wplaceUserId !== actor.wplaceUserId) continue
      this.errors.delete(entry.region.id)
      if (entry.replaceAfter !== undefined) {
        const error = this.replacementError(entry)
        if (error !== undefined) {
          this.errors.set(entry.region.id, error)
          continue
        }
        entry.deleted = true
      }
      if (!entry.deleted) {
        const documentError = claimDocumentError(entry.region.document)
        if (documentError !== null) {
          this.errors.set(entry.region.id, documentError)
          continue
        }
      }
      const recipients = entry.deleted
        ? new Map<ServerConnection, string | null>()
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
          // A withdrawn replica no longer appears in snapshots or local copy receipts.
          // Explicit deletion must still reach its retained identity on every connected server.
          .filter(
            (server) => !recipients.has(server) && (entry.deleted || this.hasCopy(entry, server)),
          )
          .map((server) => this.write(entry, server, null)),
      )
    }
    this.persist()
  }

  private replacementError(entry: Entry): string | undefined {
    for (const id of entry.replaceAfter ?? []) {
      const replacement = this.entries.get(id)
      if (replacement === undefined) continue
      const error =
        replacement.replaceAfter !== undefined
          ? this.replacementError(replacement)
          : replacement.deleted
            ? undefined
            : this.errors.get(id)
      if (error !== undefined) return error
    }
    return undefined
  }

  private hasCopy(entry: Entry, server: ServerConnection): boolean {
    return entry.copies.some((copy) => isCopyOn(copy, server))
  }

  private rememberCopy(entry: Entry, server: ServerConnection): void {
    if (!this.hasCopy(entry, server) && server.info !== null)
      entry.copies.push({ url: server.url, serverId: server.info.id })
  }

  private async write(
    entry: Entry,
    server: ServerConnection,
    region: RegionClaim | null,
  ): Promise<boolean> {
    const owner = serverConnectionIdentity(server)
    if (this.retiring.has(owner) || this.host.retired(server)) return false
    const previousFailure = this.failedServers.get(owner)
    if (previousFailure !== undefined) {
      this.errors.set(entry.region.id, previousFailure)
      return false
    }
    const signature =
      region === null ? (entry.deleted ? 'deleted' : 'withdrawn') : writeSignature(region)
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
        ? this.host.remove(server, entry.region, controller.signal, !entry.deleted)
        : this.host.put(server, region, controller.signal)
    this.inFlight.set(owner, work)
    const result = await work
    this.inFlight.delete(owner)
    this.requests.delete(owner)
    if (result.kind === 'deleted') {
      // Retain the server's deletion before another snapshot can restore this saved claim.
      entry.deleted = true
      delete entry.replaceAfter
      this.persist()
      this.wanted = true
      return false
    }
    // A disconnect in another tab can race an already dispatched PUT. Its creator still has
    // the credential and removes that late copy, even after the disconnect deadline elapsed.
    if (region !== null && this.host.retired(server)) {
      const cleanup = await this.host.remove(
        server,
        region,
        new AbortController().signal,
        !entry.deleted,
      )
      if (cleanup.kind === 'error') warn('late claim disconnect cleanup failed', cleanup.message)
      return false
    }
    if (result.kind === 'error') {
      const message = `${server.info?.name ?? server.url}: ${result.message}`
      this.errors.set(entry.region.id, message)
      this.failedServers.set(owner, message)
      return false
    }
    receipts.set(entry.region.id, signature)
    if (region === null) entry.copies = entry.copies.filter((copy) => !isCopyOn(copy, server))
    return true
  }

  /** Stop new writes and attempt only this painter's cleanup within a fixed disconnect deadline. */
  async disconnect(server: ServerConnection): Promise<void> {
    this.host.retire(server)
    const owner = serverConnectionIdentity(server)
    this.retiring.add(owner)
    this.requests.get(owner)?.abort()
    const actor = this.host.actor()
    const regions = new Map(
      this.host
        .claims(server)
        .regions.filter(
          (region) =>
            region.claimant.wplaceUserId === actor?.wplaceUserId &&
            this.host.claims(server).ownedRegionIds?.includes(region.id),
        )
        .map((region) => [region.id, region]),
    )
    const entries = [...this.entries.values(), ...this.host.saved()]
    const deleted = new Set(
      entries.filter((entry) => entry.deleted).map((entry) => entry.region.id),
    )
    for (const entry of entries)
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
          const result = await this.host.remove(
            server,
            region,
            controller.signal,
            !deleted.has(region.id),
          )
          if (result.kind === 'error') warn('claim disconnect cleanup failed', result.message)
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

/** What a server holds once a write lands, so an unchanged claim is not written again. */
const writeSignature = (region: RegionClaim): string =>
  JSON.stringify([region.document, region.label, region.templateId])

const retirementKey = (server: ServerConnection): string =>
  `${STORAGE_KEY}.retired:${encodeURIComponent(server.url)}`

/**
 * The claim journal and per-server retirement flags in storage shared by every tab. `written`
 * records whether this tab wrote during the current locked operation; a disconnect retires its
 * server without the lock, so it can land while another operation holds it.
 */
const journal = {
  written: false,
  load(): Entry[] {
    try {
      const raw: unknown = JSON.parse(storedValue(STORAGE_KEY) ?? '[]')
      return Array.isArray(raw) ? raw.filter(isEntry) : []
    } catch (error) {
      warn('could not load claims', String(error))
      return []
    }
  },
  persist(entries: readonly Entry[]): void {
    const raw = JSON.stringify(entries)
    if (storedValue(STORAGE_KEY) === raw) return
    journal.written = true
    storeValue(STORAGE_KEY, raw)
  },
  retired: (server: ServerConnection): boolean => storedValue(retirementKey(server)) === 'true',
  setRetired(server: ServerConnection, retired: boolean): void {
    journal.written = true
    storeValue(retirementKey(server), JSON.stringify(retired))
  },
}

let router: ClaimRouter | undefined
const localRouter = (): ClaimRouter =>
  (router ??= new ClaimRouter(
    {
      servers: () => claimServers().filter(canWriteClaims),
      templates: (server, region) => manifestRows(server, region.surface)?.templates,
      claims: serverClaims,
      actor: accountIdentity,
      persist: journal.persist,
      saved: journal.load,
      retired: journal.retired,
      retire: (server) => journal.setRetired(server, true),
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
      remove: (server, region, signal, withdraw) =>
        releaseRegion(server, region.id, region.claimant, region, signal, withdraw),
    },
    journal.load(),
  ))

let retryTimer: ReturnType<typeof setTimeout> | null = null

/** Try failed deliveries again once, later, while any remain. */
const scheduleRetry = (): void => {
  if (retryTimer !== null || !localRouter().failing) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void claimRouter
      .reconcile()
      .catch((error: unknown) => warn('claim routing failed', String(error)))
  }, RETRY_MS)
}

let pendingOperation: Promise<unknown> = Promise.resolve()
const withClaims = <T>(operation: (router: ClaimRouter) => Promise<T>): Promise<T> => {
  const run = async (): Promise<T> => {
    // The extension's storage is asynchronous: catch up on other tabs' writes after taking the
    // lock, and store ours before giving it up, so the next tab reads what this one wrote.
    journal.written = false
    await syncStoredValues()
    const router = localRouter()
    router.restore(journal.load())
    try {
      return await operation(router)
    } finally {
      if (journal.written) await syncStoredValues()
      scheduleRetry()
    }
  }
  const next = pendingOperation.then(async (): Promise<T> => {
    const locks = typeof navigator === 'undefined' ? null : navigator.locks
    if (locks == null) return run()
    return await locks.request<Promise<T>>(STORAGE_KEY, run)
  })
  // The chain only orders operations; each caller handles its own operation's failure.
  pendingOperation = next.catch(() => undefined)
  return next
}

let pendingReconciliation: Promise<void> | null = null

/** Share claim intent across tabs; one browser-wide writer reconciles it at a time. */
export const claimRouter = {
  /** This painter's unexpired live claims, as the journal holds them now. */
  mine: (): RegionClaim[] =>
    journal
      .load()
      .filter(
        (entry) =>
          isLive(entry) &&
          entry.region.claimant.wplaceUserId === accountIdentity()?.wplaceUserId &&
          claimExpiry(entry.region) > Date.now(),
      )
      .map((entry) => entry.region),
  saveAll: (ids: readonly string[], documents: readonly RegionDocument[]) =>
    withClaims((router) => router.saveAll(ids, documents)),
  remove: (id: string) => withClaims((router) => router.remove(id)),
  reconcile: () =>
    (pendingReconciliation ??= withClaims((router) => router.reconcile()).finally(() => {
      pendingReconciliation = null
    })),
}

/**
 * Reconcile whenever claims, connections, or catalogs change; failures retry on their own. A
 * server the user connects may receive claims again; one they disconnect is retired, and this
 * painter's claims on it are withdrawn while its credential still exists.
 */
export const installClaimRouting = (): void => {
  const reconcile = () => {
    void claimRouter
      .reconcile()
      .catch((error: unknown) => warn('claim routing failed', String(error)))
  }
  onClaimsChange(reconcile)
  onStateChange(reconcile)
  onServerSnapshot(reconcile)
  onServerConnected((server) => journal.setRetired(server, false))
  // Not behind the mutation lock: disconnecting keeps its deadline even while another tab holds it.
  onServerRemoving((server) => localRouter().disconnect(server))
  reconcile()
}
