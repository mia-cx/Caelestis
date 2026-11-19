import { decodeMismatchMask, type TileCoord } from '@caelestis/shared'
import type { BlobStore } from '../ports/index.js'

/**
 * Everything a classification depends on. A version's chunks never change, so the chunk is
 * implied by the version and tile, and the key also names the derived mask object.
 */
export interface ClassificationKey {
  readonly templateId: string
  readonly versionId: string
  readonly tile: TileCoord
  readonly canvasHash: string
}

export const mismatchArtifactKey = ({
  templateId,
  versionId,
  tile,
  canvasHash,
}: ClassificationKey): string =>
  `mismatches/templates/${templateId}/versions/${versionId}/tiles/${tile.x}/${tile.y}/canvas/${canvasHash}.cmm`

/** A stored mismatch mask, or null when it is missing or does not decode. */
export const readMismatchArtifact = async (
  blobs: BlobStore,
  key: ClassificationKey,
): Promise<Uint8Array | null> => {
  const bytes = await blobs.get('derived', mismatchArtifactKey(key))
  return bytes !== null && decodeMismatchMask(bytes) !== null ? bytes : null
}

export const putMismatchArtifact = (
  blobs: BlobStore,
  key: ClassificationKey,
  bytes: Uint8Array,
): Promise<void> => blobs.put('derived', mismatchArtifactKey(key), bytes)

/**
 * The one policy for a failed derived write: masks rebuild from durable inputs, so a lost write
 * costs only a later recomputation and never fails or rolls back the work that produced it.
 */
export const logArtifactFailure = (error: unknown): void => {
  console.error('failed to persist derived mismatch artifact', error)
}
