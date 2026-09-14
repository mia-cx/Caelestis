import assert from 'node:assert/strict'

/** Read containerd manifest targets, which differ from Docker image configuration IDs. */
export const imageTargets = (ctr) =>
  new Map(
    ctr('images', 'list')
      .split('\n')
      .slice(1)
      .filter((line) => line.trim())
      .map((line) => {
        const [reference, , digest] = line.trim().split(/\s+/)
        return [reference, digest]
      }),
  )

/** Remove recorded targets only; report replacements without deleting them. Missing refs are done. */
export function removeImageReferences(ctr, targets) {
  const replaced = []
  for (const [reference, expected] of Object.entries(targets)) {
    const current = imageTargets(ctr).get(reference)
    if (current === undefined) continue
    if (current !== expected) {
      replaced.push(reference)
      continue
    }
    ctr('images', 'remove', reference)
    assert.notEqual(imageTargets(ctr).get(reference), expected, `Image remains: ${reference}`)
  }
  return replaced
}
