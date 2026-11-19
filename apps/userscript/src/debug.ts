import { exposeDebugApi, registerDebugEntry } from './console-api.js'
import { recordProfileCounter } from './profile.js'
import { storedFlag } from './stored-values.js'

/**
 * Debug instrumentation for the render path.
 *
 * The overlay depends on a chain of inferences about someone else's WebGL traffic — which texture
 * is a tile, which tile it is, where MapLibre put it — and when one link breaks, the only visible
 * symptom is that the overlay silently goes missing. That is very hard to reason about from a
 * screenshot, so every link reports what it did and, more importantly, why it declined.
 *
 * Off by default so a shipped script stays quiet. Turn it on with the Debug logging setting or
 * `__caelestis.debug(true)` from the console, then reload to capture startup; it stays on across
 * reloads until turned off.
 * `__caelestis.dump()` prints the counters and the recent event ring, which is the thing to send when
 * something looks wrong.
 */

/** The render path's stages, from Wplace's tile fetch to the overlay's frame. */
export type RenderStage = 'fetch' | 'bitmap' | 'texture' | 'quad' | 'frame' | 'clear' | 'draw'

/** What an entry is about: a render stage, or `app` for everything else. */
type Category = RenderStage | 'app'

interface Entry {
  readonly at: number
  readonly category: Category
  readonly message: string
  readonly data?: unknown
}

const debugLogging = storedFlag('caelestisDebug')
const RING_SIZE = 400
const MAX_MESSAGE_LENGTH = 512
const MAX_DATA_STRING_LENGTH = 512
const MAX_DATA_ENTRIES = 20
const MAX_DATA_DEPTH = 3

/** Stages that fire per frame; logged to the ring always, to the console only when they change. */
const PER_FRAME: ReadonlySet<Category> = new Set(['frame', 'draw', 'quad'])

let enabled = false
let ring: Entry[] = []
const counters = new Map<string, number>()
const lastPerFrame = new Map<Category, string>()
const started = Date.now()

/** The stored Debug logging setting, which may differ from this tab's until it reloads. */
export const storedDebugLogging = debugLogging.get

/**
 * Apply the stored Debug logging setting once stored values have loaded, and say how to change it.
 * `installDebugApi` reads it earlier too, which in the userscript catches the page hooks' own logs.
 */
export const loadDebugSetting = (): void => {
  enabled = debugLogging.get()
  try {
    console.info(
      enabled
        ? '[caelestis] debug is ON. __caelestis.dump() to print, __caelestis.debug(false) to stop.'
        : '[caelestis] debug is off. __caelestis.debug(true) then reload to capture everything.',
    )
  } catch {
    // A replaced console is not part of the render path.
  }
}

/**
 * How many distinct counter keys to keep.
 *
 * Counters run even with debugging off, and callers write tile coordinates into their messages — so
 * keying on the message meant panning across a map added a permanent entry per tile. The ring bounds
 * the log; nothing bounded this.
 */
const MAX_COUNTERS = 200

const DROPPED = 'debug:counter-keys-dropped'

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`

/** Copy only a small diagnostic snapshot; never retain page/import-owned objects in the ring. */
const snapshot = (value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown => {
  if (typeof value === 'string') return truncate(value, MAX_DATA_STRING_LENGTH)
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return value
  }
  if (typeof value !== 'object') return truncate(String(value), MAX_DATA_STRING_LENGTH)
  try {
    if (Object.prototype.toString.call(value) === '[object Error]') {
      const error = value as { readonly name?: unknown; readonly message?: unknown }
      const name = typeof error.name === 'string' ? error.name : 'Error'
      const message = typeof error.message === 'string' ? error.message : ''
      return truncate(message.length > 0 ? `${name}: ${message}` : name, MAX_DATA_STRING_LENGTH)
    }
  } catch {}
  if (seen.has(value)) return '[circular]'
  if (depth >= MAX_DATA_DEPTH) return Object.prototype.toString.call(value)
  seen.add(value)
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_DATA_ENTRIES).map((entry) => snapshot(entry, depth + 1, seen))
    if (value.length > MAX_DATA_ENTRIES) out.push(`… ${value.length - MAX_DATA_ENTRIES} more`)
    return out
  }
  const out: Record<string, unknown> = {}
  let entries = 0
  try {
    for (const key in value as Record<string, unknown>) {
      if (entries >= MAX_DATA_ENTRIES) {
        out['…'] = 'more properties omitted'
        break
      }
      out[truncate(key, MAX_DATA_STRING_LENGTH)] = snapshot(
        (value as Record<string, unknown>)[key],
        depth + 1,
        seen,
      )
      entries++
    }
    return out
  } catch {
    return Object.prototype.toString.call(value)
  }
}

export const count = (key: string, by = 1): void => {
  recordProfileCounter(key, by)
  if (!counters.has(key) && counters.size >= MAX_COUNTERS) {
    // Set directly rather than recursing: at capacity, counting the drop would count its own drop.
    counters.set(DROPPED, (counters.get(DROPPED) ?? 0) + 1)
    return
  }
  counters.set(key, (counters.get(key) ?? 0) + by)
}

/** The stable part of a message: everything up to the first digit-bearing word. */
const counterKey = (category: Category, message: string): string =>
  `${category}:${message.replace(/\s*\S*\d\S*/g, '').trim()}`

const record = (category: Category, message: string, data: unknown): void => {
  try {
    const boundedMessage = truncate(message, MAX_MESSAGE_LENGTH)
    count(counterKey(category, boundedMessage))
    if (!enabled) return
    const boundedData = snapshot(data)

    const entry: Entry = {
      at: Date.now() - started,
      category,
      message: boundedMessage,
      data: boundedData,
    }
    ring.push(entry)
    if (ring.length > RING_SIZE) ring.shift()

    // A per-frame stage would drown the console, so it only speaks when its story changes.
    if (PER_FRAME.has(category)) {
      const signature = `${boundedMessage}:${JSON.stringify(boundedData ?? null)}`
      if (lastPerFrame.get(category) === signature) return
      lastPerFrame.set(category, signature)
    }
    if (boundedData === undefined) console.info(`[caelestis:${category}] ${boundedMessage}`)
    else console.info(`[caelestis:${category}] ${boundedMessage}`, boundedData)
  } catch {
    // Diagnostics are observers. A hostile/broken page console or unserialisable debug payload must
    // never change the success semantics of the operation being observed.
  }
}

/** Record a diagnostic; it reaches the console while debug logging is on. */
export const log = (message: string, data?: unknown): void => record('app', message, data)

/** Like `log`, tagged with its render stage; per-frame stages reach the console only on change. */
export const logRender = (stage: RenderStage, message: string, data?: unknown): void =>
  record(stage, message, data)

/** Always reaches the console, debug on or off: something that should not have happened. */
export const warn = (message: string, data?: unknown): void => {
  try {
    // Same stable key as `log`. Keyed on the raw message, the two hottest warnings carry tile
    // coordinates and filled the 200-key table with single-use entries — after which every genuinely
    // new counter was refused, and `dump()` stopped showing the ones worth reading.
    const boundedMessage = truncate(message, MAX_MESSAGE_LENGTH)
    const boundedData = snapshot(data)
    count(counterKey('app', boundedMessage))
    ring.push({
      at: Date.now() - started,
      category: 'app',
      message: boundedMessage,
      data: boundedData,
    })
    if (ring.length > RING_SIZE) ring.shift()
    // Keep the bounded snapshot in the ring, but let devtools see the original Error so its stack
    // remains inspectable. This is a console argument only; the diagnostic store retains no page or
    // import-owned object.
    console.warn(`[caelestis:app] ${boundedMessage}`, data ?? '')
  } catch {
    // Warnings report failures; they must not create a second failure of their own.
  }
}

export const isEnabled = (): boolean => enabled

/** Turn logging on or off and remember it. Shared by `__caelestis.debug()` and the Diagnostics setting. */
export const setEnabled = (on: boolean): void => {
  enabled = on
  debugLogging.set(on)
}

export const installDebugApi = (): void => {
  enabled = debugLogging.get()
  // Switched in the extension's toolbar popup or another tab: applies here from the next event on.
  debugLogging.onChange((on) => {
    enabled = on
  })
  registerDebugEntry('debug', (on: boolean) => {
    setEnabled(on)
    return `[caelestis] debug ${on ? 'on' : 'off'} — reload to capture startup, __caelestis.dump() to print`
  })
  registerDebugEntry('dump', () => {
    const sorted = [...counters.entries()].sort((a, b) => b[1] - a[1])
    console.group('[caelestis] debug dump')
    console.info('enabled:', enabled, '| uptime:', `${Date.now() - started}ms`)
    console.table(Object.fromEntries(sorted))
    console.info(`last ${ring.length} events:`)
    for (const entry of ring) {
      console.info(`  +${entry.at}ms [${entry.category}] ${entry.message}`, entry.data ?? '')
    }
    console.groupEnd()
  })
  registerDebugEntry('counters', () => Object.fromEntries(counters))
  registerDebugEntry('events', (category?: Category) =>
    category === undefined ? [...ring] : ring.filter((entry) => entry.category === category),
  )
  registerDebugEntry('clear', () => {
    ring = []
    counters.clear()
    lastPerFrame.clear()
  })
  exposeDebugApi()
}
