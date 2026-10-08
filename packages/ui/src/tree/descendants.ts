/**
 * The rows nested under `key` in a flattened tree: the contiguous run of entries after `key`
 * whose depth is greater, stopping at the first sibling or shallower row. Expanding or
 * collapsing a row adds or removes exactly this run, so it is also the set of rows a
 * grow/shrink transition should touch.
 */
export const descendantKeys = (
  entries: readonly { key: string; depth: number }[],
  key: string,
): Set<string> => {
  const keys = new Set<string>()
  let depth: number | undefined
  for (const entry of entries) {
    if (depth === undefined) {
      if (entry.key === key) depth = entry.depth
      continue
    }
    if (entry.depth <= depth) break
    keys.add(entry.key)
  }
  return keys
}
