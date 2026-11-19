/**
 * The toolkit for instrumenting the page's own objects.
 *
 * Every hook here wraps a native call that Wplace, or a script beside it, depends on. Each one must
 * leave that call's observable contract exactly as it was: the same result, the same errors, the
 * same metadata. Observation runs after the native call and can never change its outcome.
 */

export interface InstalledValueHook {
  restore(): void
}

/** Install an own hook without inheriting another script's non-writable prototype descriptor. */
export const installValueHook = (
  target: object,
  property: PropertyKey,
  value: unknown,
): InstalledValueHook | null => {
  let previous: PropertyDescriptor | undefined
  try {
    previous = Object.getOwnPropertyDescriptor(target, property)
    let inherited: PropertyDescriptor | undefined
    if (previous === undefined) {
      let prototype = Object.getPrototypeOf(target)
      while (prototype !== null && inherited === undefined) {
        inherited = Object.getOwnPropertyDescriptor(prototype, property)
        prototype = Object.getPrototypeOf(prototype)
      }
    }
    const replaced = previous ?? inherited
    if (typeof value === 'function' && typeof replaced?.value === 'function') {
      for (const metadata of ['name', 'length'] as const) {
        const metadataDescriptor = Object.getOwnPropertyDescriptor(replaced.value, metadata)
        if (metadataDescriptor !== undefined && 'value' in metadataDescriptor) {
          Object.defineProperty(value, metadata, {
            value: metadataDescriptor.value,
            configurable: true,
          })
        }
      }
    }
    const descriptor =
      previous?.configurable === false
        ? { value }
        : {
            value,
            writable: true,
            configurable: true,
            enumerable: previous?.enumerable ?? inherited?.enumerable ?? false,
          }
    Object.defineProperty(target, property, descriptor)
  } catch {
    return null
  }
  return {
    restore() {
      try {
        if (Object.getOwnPropertyDescriptor(target, property)?.value !== value) return
        if (previous === undefined) Reflect.deleteProperty(target, property)
        else Object.defineProperty(target, property, previous)
      } catch {
        // A later owner changed the surface; restoring ours is no longer safe or necessary.
      }
    },
  }
}

/** Run instrumentation around a native call without changing the native call's contract. */
export const runObservedCall = <Result>(native: () => Result, observe: () => void): Result => {
  const result = native()
  try {
    observe()
  } catch {
    // The page already got a successful native operation. Instrumentation cannot change that fact.
  }
  return result
}

/** Mirror WebIDL's unsigned-long conversion without re-running user-controlled object coercion. */
export const sideEffectFreeUnsignedLong = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
    return undefined
  }
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric === 0) return 0
  const integer = Math.trunc(numeric)
  const range = 2 ** 32
  return ((integer % range) + range) % range
}
