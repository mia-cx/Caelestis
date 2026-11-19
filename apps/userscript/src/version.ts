const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

type VersionParts = readonly [major: bigint, minor: bigint, patch: bigint]

/** An x.y.z version, as its label and comparable parts. */
export interface ParsedVersion {
  readonly label: string
  readonly parts: VersionParts
}

/** Read `value` as x.y.z, or through `pattern`, whose first three groups are the parts. */
export const parseVersion = (value: string, pattern = VERSION): ParsedVersion | null => {
  const match = pattern.exec(value)
  if (match === null) return null
  const major = match[1]
  const minor = match[2]
  const patch = match[3]
  if (major === undefined || minor === undefined || patch === undefined) return null
  return {
    label: `${major}.${minor}.${patch}`,
    parts: [BigInt(major), BigInt(minor), BigInt(patch)],
  }
}

/** Negative when `left` is older than `right`, positive when newer, 0 when equal. */
export const compareVersions = (left: ParsedVersion, right: ParsedVersion): number => {
  for (const index of [0, 1, 2] as const) {
    if (left.parts[index] === right.parts[index]) continue
    return left.parts[index] > right.parts[index] ? 1 : -1
  }
  return 0
}
