/**
 * `AbortSignal.any`: a signal that aborts with the first of `signals` to abort. Safari only has it
 * from 17.4, and without it every server request would throw before it is sent.
 */
export const anySignal = (signals: readonly AbortSignal[]): AbortSignal => {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([...signals])
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), {
      once: true,
      signal: controller.signal,
    })
  }
  return controller.signal
}
