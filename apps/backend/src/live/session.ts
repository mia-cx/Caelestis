import {
  isSha256Hex,
  type LiveDashboardSubscription,
  type LiveProjectionState,
  MAX_LIVE_BINARY_HEADER_BYTES,
  MAX_LIVE_BINARY_PAYLOAD_BYTES,
  type Scope,
} from '@caelestis/shared'
import type { CoordinatorStorage } from '../coordination/database.js'
import { serialQueue } from '../runtime/serial-queue.js'
import type { StatusVisibilityScope } from '../status-read-model/model.js'

export const MAX_LIVE_SUBSCRIBERS = 256
export const MAX_LIVE_ANONYMOUS_SUBSCRIBERS = 128
export const MAX_LIVE_SUBSCRIBERS_PER_CLIENT = 16
export const MAX_LIVE_CLIENT_MESSAGE_CODE_UNITS = 64 * 1024
export const MAX_LIVE_CLIENT_BINARY_BYTES =
  4 + MAX_LIVE_BINARY_HEADER_BYTES + MAX_LIVE_BINARY_PAYLOAD_BYTES

export interface LiveSocket {
  readonly readyState?: number
  send(message: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
  serializeAttachment(attachment: unknown): void
  deserializeAttachment(): unknown
}

/** What a runtime provides a live coordinator: durable storage, its sockets, and upgrades. */
export interface LiveHost<Client> {
  readonly storage: CoordinatorStorage
  getWebSockets(tag: string): readonly LiveSocket[]
  connect(attachment: unknown): { client: Client; server: LiveSocket }
  upgradeResponse(client: Client, headers: Headers): Response | Promise<Response>
}

/** An authenticated live-sync connection, as the HTTP boundary admitted it. */
export interface StatusLiveConnection {
  readonly season: number
  readonly scope: StatusVisibilityScope
  readonly credentialScope: Scope
  readonly tokenHash: string
  readonly clientHash: string
  readonly anonymous: boolean
  readonly revocable: boolean
  /** The status revision the client holds, or null for none. */
  readonly lastRevision: number | null
  readonly metricClient: string
  readonly metricClientVersion: string
  readonly protocol: 1 | 2
  /** The client opens with a state vector instead of being told the current revision. */
  readonly stateVector: boolean
}

/** What a live-sync socket remembers across messages, and across hibernation on Cloudflare. */
export interface LiveSubscriberAttachment {
  readonly season: number
  readonly scope: StatusVisibilityScope
  readonly credentialScope?: Scope
  readonly tokenHash: string
  readonly clientHash?: string
  readonly anonymous?: boolean
  readonly revocable: boolean
  readonly lastRevision: number | null
  readonly stateVectorReceived?: boolean
  readonly revoked?: boolean
  readonly metricClient?: string
  readonly metricClientVersion?: string
  readonly protocol: 1 | 2
  readonly projections?: readonly LiveProjectionState[]
  readonly dashboardSubscriptions?: readonly LiveDashboardSubscription[]
}

/**
 * The socket's live-sync attachment, or null when it holds none. A hibernated socket can outlive
 * the deploy that attached it, so the fields every broadcast relies on are checked, not assumed.
 */
export const subscriberOf = (socket: LiveSocket): LiveSubscriberAttachment | null => {
  const attachment: unknown = socket.deserializeAttachment()
  if (typeof attachment !== 'object' || attachment === null) return null
  const held = attachment as Partial<Record<keyof LiveSubscriberAttachment, unknown>>
  return Number.isSafeInteger(held.season) &&
    (held.scope === 'public' || held.scope === 'admin') &&
    isSha256Hex(held.tokenHash) &&
    typeof held.revocable === 'boolean'
    ? (attachment as LiveSubscriberAttachment)
    : null
}

export interface LiveSessionFence {
  readonly attach: <A>(revalidate: () => Promise<boolean>, attach: () => A) => Promise<A | null>
  readonly revoke: (close: () => void | Promise<void>) => Promise<void>
}

/** Serialize the second credential check, socket attachment, and revocation close scan. */
export const createLiveSessionFence = (): LiveSessionFence => {
  const exclusive = serialQueue()
  return {
    attach: (revalidate, attach) => exclusive(async () => ((await revalidate()) ? attach() : null)),
    revoke: (close) => exclusive(async () => close()),
  }
}
