import { count } from './debug.js'
import { onStoredValueChange, storedValue, storeValue } from './stored-values.js'

/** How one switch set is written to its stored value, which older builds also read. */
export interface SwitchCodec<Id extends string> {
  /** The switches a stored value sets; absent ones keep their default. */
  readonly parse: (stored: unknown) => Partial<Record<Id, boolean>>
  readonly serialise: (switches: Readonly<Record<Id, boolean>>) => unknown
}

/**
 * A set of named on/off switches kept in one stored value.
 *
 * The extension's toolbar popup and other tabs change the same value, so a change made anywhere
 * reaches `onChange` here, as if switched in this tab.
 */
export const storedSwitches = <Id extends string>(
  key: string,
  defaults: Readonly<Record<Id, boolean>>,
  codec: SwitchCodec<Id>,
) => {
  const ids = Object.keys(defaults) as Id[]
  const listeners = new Set<(id: Id, on: boolean) => void>()
  let cached: Record<Id, boolean> | null = null

  const read = (): Record<Id, boolean> => {
    try {
      return { ...defaults, ...codec.parse(JSON.parse(storedValue(key) ?? 'null')) }
    } catch {
      return { ...defaults }
    }
  }
  const current = (): Record<Id, boolean> => {
    cached ??= read()
    return cached
  }
  const announce = (id: Id, on: boolean): void => {
    for (const listener of listeners) {
      try {
        listener(id, on)
      } catch {
        count(`${key}:listener failed`)
      }
    }
  }

  onStoredValueChange((changed) => {
    if (changed !== key) return
    const before = current()
    cached = read()
    for (const id of ids) if (before[id] !== cached[id]) announce(id, cached[id])
  })

  return {
    isOn: (id: Id): boolean => current()[id],
    all: (): Readonly<Record<Id, boolean>> => ({ ...current() }),
    set: (id: Id, on: boolean): void => {
      const switches = current()
      if (switches[id] === on) return
      switches[id] = on
      try {
        storeValue(key, JSON.stringify(codec.serialise(switches)))
      } catch {
        // The switch still applies for this session.
      }
      announce(id, on)
    },
    /** Notified when a switch flips, here or anywhere else. Returns a function that stops it. */
    onChange: (listener: (id: Id, on: boolean) => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Test seam: read storage afresh and forget every listener. */
    reset: (): void => {
      cached = null
      listeners.clear()
    },
  }
}
