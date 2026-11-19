import { warn } from './debug.js'

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
