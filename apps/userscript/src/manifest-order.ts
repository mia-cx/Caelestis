import { Semaphore } from './concurrency.js'

/**
 * The order of manifest reads. Every read that starts takes the next number, process-wide, so a
 * response can be ordered against the writes made before it and against the responses of other
 * reads, even across a reconnect to the same URL.
 */

const MANIFEST_READ_SLOTS = 4

let manifestSequence = 0
const manifestReads = new Semaphore(MANIFEST_READ_SLOTS)

/**
 * Hold one of the manifest read slots for `read`, numbering it as it starts. `canStart` is checked
 * once admitted: the caller's connection may have been replaced while it waited.
 */
export const withManifestReadSlot = async <Result>(
  signal: AbortSignal,
  read: (sequence: number) => Promise<Result>,
  canStart: () => boolean = () => true,
): Promise<Result> => {
  const result = await manifestReads.run(signal, async () => {
    if (!canStart()) throw new Error('manifest read superseded before it started')
    return { value: await read(++manifestSequence) }
  })
  if (result === undefined) throw new Error('manifest read cancelled')
  return result.value
}

/** The number the most recent manifest read started with. */
export const serverManifestSequence = (): number => manifestSequence
