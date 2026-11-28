/** Takes the fallback's listeners off its inputs once the combined signal is collected. */
const detach = new FinalizationRegistry<() => void>((remove) => remove())

/**
 * `AbortSignal.any`: a signal that aborts with the first of `signals` to abort. Safari only has it
 * from 17.4, and without it every server request would throw before it is sent.
 *
 * Like the native one, the fallback holds its result weakly: a long-lived input, such as a server
 * connection's signal, keeps no request's signal alive, and its listener leaves once that signal is
 * collected or an input aborts.
 */
export const anySignal = (signals: readonly AbortSignal[]): AbortSignal => {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([...signals])
  const controller = new AbortController()
  const target = new WeakRef(controller)
  const remove = (): void => {
    for (const signal of signals) signal.removeEventListener('abort', abort)
  }
  function abort(this: AbortSignal): void {
    remove()
    target.deref()?.abort(this.reason)
  }
  for (const signal of signals) {
    if (signal.aborted) {
      remove()
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener('abort', abort)
  }
  detach.register(controller.signal, remove)
  return controller.signal
}
