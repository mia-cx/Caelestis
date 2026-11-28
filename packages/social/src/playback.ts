import { type ArchiveTileFrame, archiveTileHash, type TileHistoryResponse } from '@caelestis/shared'

export interface PlaybackFrame {
  readonly bucketStart: number
  readonly hash: string | undefined
  readonly missing?: boolean
}

/** Archive playback ends when native observations begin; later gaps stay native. */
export const mergeArchiveFrames = (
  live: TileHistoryResponse,
  archive: readonly ArchiveTileFrame[],
): readonly PlaybackFrame[] => {
  const firstLive = live.frames.reduce(
    (first, frame) => Math.min(first, frame.bucketStart),
    Infinity,
  )
  const frames: PlaybackFrame[] = live.frames.map((frame) =>
    frame.at === undefined ? frame : { ...frame, bucketStart: frame.at },
  )
  for (const frame of archive) {
    if (frame.at >= firstLive) continue
    frames.push({
      bucketStart: frame.at,
      hash: frame.hash === null ? undefined : archiveTileHash(frame.hash),
      ...(frame.hash === null ? { missing: true } : {}),
    })
  }
  return frames.sort((a, b) => a.bucketStart - b.bucketStart)
}
