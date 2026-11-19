/**
 * Values held per server URL and, within one server, per key. Forgetting a server drops all of
 * its values at once, so no caller builds composite string keys or scans for a URL prefix.
 */
export class PerServerMap<Value, Key = string> {
  readonly #servers = new Map<string, Map<Key, Value>>()

  get(serverUrl: string, key: Key): Value | undefined {
    return this.#servers.get(serverUrl)?.get(key)
  }

  has(serverUrl: string, key: Key): boolean {
    return this.#servers.get(serverUrl)?.has(key) === true
  }

  set(serverUrl: string, key: Key, value: Value): void {
    let held = this.#servers.get(serverUrl)
    if (held === undefined) {
      held = new Map()
      this.#servers.set(serverUrl, held)
    }
    held.set(key, value)
  }

  delete(serverUrl: string, key: Key): boolean {
    const held = this.#servers.get(serverUrl)
    if (held === undefined || !held.delete(key)) return false
    if (held.size === 0) this.#servers.delete(serverUrl)
    return true
  }

  /** One server's entries, in insertion order. */
  entries(serverUrl: string): IterableIterator<[Key, Value]> {
    return (this.#servers.get(serverUrl) ?? new Map<Key, Value>()).entries()
  }

  *all(): IterableIterator<[serverUrl: string, key: Key, value: Value]> {
    for (const [serverUrl, held] of this.#servers)
      for (const [key, value] of held) yield [serverUrl, key, value]
  }

  /** Drop every value held for `serverUrl` and hand them back. */
  forget(serverUrl: string): ReadonlyMap<Key, Value> {
    const held = this.#servers.get(serverUrl) ?? new Map<Key, Value>()
    this.#servers.delete(serverUrl)
    return held
  }
}
