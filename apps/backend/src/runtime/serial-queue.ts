/** Run operations one at a time, in call order. A failed operation does not stop the next one. */
export type SerialQueue = <A>(operation: () => Promise<A>) => Promise<A>

export const serialQueue = (): SerialQueue => {
  let tail: Promise<unknown> = Promise.resolve()
  return (operation) => {
    const running = tail.then(operation, operation)
    tail = running.then(
      () => undefined,
      () => undefined,
    )
    return running
  }
}
