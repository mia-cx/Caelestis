export type TileOfferDecision = 'fresh' | 'retry' | 'pending' | 'avoid'

/** How long a receipt answers for an observation before it may be offered again. */
const RECEIPT_TTL_MS = 5 * 60_000
const MAX_SERVERS = 32
const MAX_RECEIPTS_PER_SERVER = 4_096

type TileOfferReceipt =
  /** Offered and unanswered; expires so a thrown or abandoned request cannot block forever. */
  | {
      readonly state: 'in-flight'
      readonly expiresAt: number
      readonly coverageGeneration: number
    }
  | { readonly state: 'acknowledged' | 'rejected'; readonly expiresAt: number }
  /** Failed in a way worth repeating: the next observation is offered again. */
  | { readonly state: 'retryable' }

interface ServerAcknowledgements {
  readonly owner: object
  readonly season: number
  readonly receipts: Map<string, TileOfferReceipt>
  coverageGeneration: number
}

/**
 * Bounded acknowledgement receipts for one browser runtime.
 *
 * A configured server's opaque connection owner fences reconnects without putting credentials in a
 * key. Restarting the userscript also deliberately drops every receipt: either event makes prior
 * acknowledgement state uncertain, so the safe recovery is to offer the observation again.
 */
export class TileOfferAcknowledgements {
  readonly #servers = new Map<string, ServerAcknowledgements>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  decision(
    serverUrl: string,
    owner: object,
    season: number,
    observation: string,
  ): TileOfferDecision {
    const server = this.#server(serverUrl, owner, season)
    const receipt = server.receipts.get(observation)
    if (receipt === undefined) return 'fresh'
    server.receipts.delete(observation)
    if (receipt.state === 'retryable' || receipt.expiresAt <= this.#now()) return 'retry'
    server.receipts.set(observation, receipt)
    return receipt.state === 'in-flight' ? 'pending' : 'avoid'
  }

  started(serverUrl: string, owner: object, season: number, observation: string): void {
    const server = this.#server(serverUrl, owner, season)
    this.#remember(server, observation, {
      state: 'in-flight',
      coverageGeneration: server.coverageGeneration,
      expiresAt: this.#now() + RECEIPT_TTL_MS,
    })
  }

  retryable(serverUrl: string, owner: object, season: number, observation: string): void {
    const server = this.#settlementServer(serverUrl, owner, season)
    if (server === null) return
    this.#remember(server, observation, { state: 'retryable' })
  }

  acknowledged(serverUrl: string, owner: object, season: number, observation: string): void {
    const server = this.#settlementServer(serverUrl, owner, season)
    if (server === null) return
    this.#remember(server, observation, {
      state: 'acknowledged',
      expiresAt: this.#now() + RECEIPT_TTL_MS,
    })
  }

  rejected(serverUrl: string, owner: object, season: number, observation: string): boolean {
    const server = this.#settlementServer(serverUrl, owner, season)
    if (server === null) return false
    const pending = server.receipts.get(observation)
    if (
      pending?.state === 'in-flight' &&
      pending.coverageGeneration !== server.coverageGeneration
    ) {
      this.#remember(server, observation, { state: 'retryable' })
      return false
    }
    this.#remember(server, observation, {
      state: 'rejected',
      expiresAt: this.#now() + RECEIPT_TTL_MS,
    })
    return true
  }

  invalidateRejections(serverUrl: string, owner: object, season: number): void {
    const server = this.#servers.get(serverUrl)
    if (server === undefined || server.owner !== owner || server.season !== season) return
    server.coverageGeneration++
    for (const [observation, receipt] of server.receipts) {
      if (receipt.state === 'rejected') server.receipts.delete(observation)
    }
  }

  #remember(server: ServerAcknowledgements, observation: string, receipt: TileOfferReceipt): void {
    server.receipts.delete(observation)
    while (server.receipts.size >= MAX_RECEIPTS_PER_SERVER) {
      const oldest = server.receipts.keys().next()
      if (oldest.done) break
      server.receipts.delete(oldest.value)
    }
    server.receipts.set(observation, receipt)
  }

  #settlementServer(
    serverUrl: string,
    owner: object,
    season: number,
  ): ServerAcknowledgements | null {
    const existing = this.#servers.get(serverUrl)
    if (existing === undefined) return this.#server(serverUrl, owner, season)
    if (existing.owner !== owner || existing.season !== season) return null
    this.#servers.delete(serverUrl)
    this.#servers.set(serverUrl, existing)
    return existing
  }

  #server(serverUrl: string, owner: object, season: number): ServerAcknowledgements {
    const existing = this.#servers.get(serverUrl)
    if (existing !== undefined && existing.owner === owner && existing.season === season) {
      this.#servers.delete(serverUrl)
      this.#servers.set(serverUrl, existing)
      return existing
    }
    this.#servers.delete(serverUrl)
    while (this.#servers.size >= MAX_SERVERS) {
      const oldest = this.#servers.keys().next()
      if (oldest.done) break
      this.#servers.delete(oldest.value)
    }
    const created = {
      owner,
      season,
      receipts: new Map<string, TileOfferReceipt>(),
      coverageGeneration: 0,
    }
    this.#servers.set(serverUrl, created)
    return created
  }
}
