import { count, warn } from './debug.js'

/** Call every listener with `args`; one that throws is reported as `failure` and the rest still run. */
export const notifyListeners = <Args extends unknown[]>(
  listeners: Iterable<(...args: Args) => void>,
  failure: string,
  ...args: Args
): void => {
  for (const listener of listeners) {
    try {
      listener(...args)
    } catch (error) {
      warn(failure, String(error))
    }
  }
}

/**
 * Call every listener, counting rather than propagating a failure: these run inside page code,
 * where one consumer's bug must neither reach Wplace nor stop the consumers after it.
 */
export const notifyEach = <Listener>(
  listeners: Iterable<Listener>,
  call: (listener: Listener) => void,
  failure: string,
): void => {
  for (const listener of listeners) {
    try {
      call(listener)
    } catch {
      count(failure)
    }
  }
}
