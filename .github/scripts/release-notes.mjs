const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const releaseNotesFor = (changelog, version) => {
  const heading = new RegExp(`^## ${escapeRegExp(version)}\\s*$`, 'm')
  const match = heading.exec(changelog)
  if (match === null) throw new Error(`CHANGELOG.md has no ${version} release section`)
  const afterHeading = changelog.slice(match.index + match[0].length).replace(/^\r?\n/, '')
  const nextHeading = afterHeading.search(/^## /m)
  const notes = (nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)).trim()
  if (notes.length === 0) throw new Error(`CHANGELOG.md has an empty ${version} release section`)
  return notes
}

/**
 * Fits release notes into a store's character limit. Keeps whole top-level bullets, in order, and
 * links the full notes when any are left out.
 */
export const fitReleaseNotes = (notes, limit, fullNotesUrl) => {
  if (notes.length <= limit) return notes
  const more = `Full notes: ${fullNotesUrl}`
  let fitted = ''
  for (const item of notes.split(/\n(?=- )/)) {
    const next = fitted === '' ? item : `${fitted}\n${item}`
    if (next.length + more.length + 2 > limit) break
    fitted = next
  }
  return fitted === '' ? more : `${fitted}\n\n${more}`
}
