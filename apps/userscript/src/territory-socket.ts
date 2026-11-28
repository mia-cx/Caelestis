import { isRecord } from '@caelestis/shared'
import { warn } from './debug.js'
import { installValueHook, runObservedCall } from './page-hooks.js'
import { pageWindow } from './page-world.js'
import { BACKEND_ORIGIN } from './wplace-raster.js'

/**
 * Wplace's territory socket, `wss://backend.wplace.live/territory/ws`, observed for every reader.
 *
 * The territory event's store talks to its server over this socket: it sends `{ t, id, … }` text
 * frames (`paint`, `swap`, `join`) and the server answers each with `{ t: 'ack', id, result }` or
 * `{ t: 'ack', id, error }`, beside `hello`, `teams` and `tick` messages and binary pixel frames.
 * The page's `WebSocket` becomes a proxy that builds every socket natively. Only on the territory
 * socket does it add a message and a close listener, and an own `send` that calls the native one
 * and then reports the frame. Nothing Wplace sends or receives changes.
 */

/** A text frame on the territory socket, parsed. */
export type TerritoryMessage = Readonly<Record<string, unknown>>

/** What a reader hears from the territory socket. Each call runs after Wplace's own handling. */
export interface TerritorySocketObserver {
  /** A text frame Wplace sent, once the native `send` took it. */
  readonly sent?: (message: TerritoryMessage) => void
  /** A text frame the server sent. */
  readonly received?: (message: TerritoryMessage) => void
  /** The socket closed; Wplace fails every request still waiting for its reply. */
  readonly closed?: () => void
}

const TERRITORY_SOCKET_PATH = '/territory/ws'
const territoryHost = new URL(BACKEND_ORIGIN).host

const observers = new Set<TerritorySocketObserver>()
let tapped = false

const parse = (data: unknown): TerritoryMessage | null => {
  if (typeof data !== 'string') return null
  try {
    const message: unknown = JSON.parse(data)
    return isRecord(message) ? message : null
  } catch {
    return null
  }
}

/** Tell every observer, so one that throws neither stops the rest nor reaches Wplace. */
const notify = (hear: (observer: TerritorySocketObserver) => void): void => {
  for (const observer of observers)
    try {
      hear(observer)
    } catch (error) {
      warn('territory socket observer failed', String(error))
    }
}

const isTerritorySocket = (url: unknown, realm: Window & typeof globalThis): boolean => {
  if (typeof url !== 'string' && !(url instanceof URL)) return false
  const parsed = new URL(url, realm.location?.href)
  return parsed.host === territoryHost && parsed.pathname === TERRITORY_SOCKET_PATH
}

const observeSocket = (socket: WebSocket): void => {
  socket.addEventListener('message', (event) => {
    const message = parse(event.data)
    if (message !== null) notify((observer) => observer.received?.(message))
  })
  socket.addEventListener('close', () => notify((observer) => observer.closed?.()))
  const send = socket.send
  if (typeof send !== 'function') return
  // A `function`, so Wplace's `socket.send(…)` still runs the native send on the socket.
  installValueHook(socket, 'send', function (this: WebSocket, ...args: unknown[]): unknown {
    return runObservedCall(
      () => Reflect.apply(send, this, args),
      () => {
        const message = parse(args[0])
        if (message !== null) notify((observer) => observer.sent?.(message))
      },
    )
  })
}

const tapTerritorySocket = (realm: Window & typeof globalThis): void => {
  const native = realm.WebSocket
  if (typeof native !== 'function') return
  const proxied = new Proxy(native, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget) as WebSocket
      try {
        if (isTerritorySocket(args[0], realm)) observeSocket(socket)
      } catch (error) {
        warn('territory socket unobserved', String(error))
      }
      return socket
    },
  })
  installValueHook(realm, 'WebSocket', proxied)
}

/**
 * Hear the territory sockets Wplace opens from now on. The first observer taps the page's
 * `WebSocket`; later ones share that tap.
 */
export const observeTerritorySocket = (observer: TerritorySocketObserver): void => {
  observers.add(observer)
  if (tapped) return
  tapped = true
  tapTerritorySocket(pageWindow())
}
