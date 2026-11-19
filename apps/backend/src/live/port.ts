import { NotFoundError } from '../runtime/errors.js'
import type { StatusLiveConnection } from './session.js'

/** Live sync: one season's status coordinator, wherever it runs, admits the socket. */
export interface LiveSyncPort {
  connect(request: Request, connection: StatusLiveConnection): Promise<Response>
}

/** A host without live sockets, such as tests and scripts. */
export const noLiveSync: LiveSyncPort = {
  connect: () => Promise.reject(new NotFoundError({ message: 'not found' })),
}
