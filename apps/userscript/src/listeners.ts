import { warn } from './debug.js'

/**
 * Call every listener with `args`. One that throws is warned about (and counted) as `failure`, and
 * the rest still run: many of these run inside page hooks, where one consumer's bug must neither
 * reach Wplace nor stop the consumers after it.
 */
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
