/**
 * Coalesce arbitrary notifications into at most one `run` per scheduled callback: an animation
 * frame by default, or whatever `request` schedules.
 */
export const frameQueue = (
  run: () => void,
  request: (callback: () => void) => void = requestAnimationFrame,
): (() => void) => {
  let queued = false
  return () => {
    if (queued) return
    queued = true
    request(() => {
      queued = false
      run()
    })
  }
}
