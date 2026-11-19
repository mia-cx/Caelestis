import { NotFoundError } from '../runtime/errors.js'
import type { StatusLiveConnection } from './session.js'

/** Live sync: one season's status coordinator, wherever it runs, admits the socket. */
export interface LiveSyncPort {
  /** `request` is what a Durable Object hop forwards; an in-process coordinator needs only the connection. */
  connect(connection: StatusLiveConnection, request: Request): Promise<Response>
}

/** A host without live sockets, such as tests and scripts. */
export const noLiveSync: LiveSyncPort = {
  connect: () => Promise.reject(new NotFoundError({ message: 'not found' })),
}
