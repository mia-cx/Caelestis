import type { Attachment } from 'svelte/attachments'

/**
 * Give a `.caelestis-select` a face that cuts a long option short of the caret.
 *
 * Under `appearance: base-select` a select clips nothing itself, so a long label ran under the
 * caret its background draws. A `<button><selectedcontent>` child becomes its face instead, and
 * that face ellipsises (MenuStyles). It is added here rather than in markup: a browser without
 * customizable selects drops a `<button>` inside a `<select>` while parsing, and there the select
 * already clips its own text.
 */
export const selectFace: Attachment<HTMLSelectElement> = (select) => {
  if (typeof CSS === 'undefined' || !CSS.supports('appearance', 'base-select')) return
  const face = document.createElement('button')
  face.className = 'caelestis-select-face'
  face.append(document.createElement('selectedcontent'))
  select.prepend(face)
  return () => face.remove()
}
