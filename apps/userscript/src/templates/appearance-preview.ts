import type { Appearance } from './appearance.js'

type PreviewKey = keyof Appearance
type PreviewValue = Appearance[PreviewKey]

const previews = new Map<string, Map<PreviewKey, PreviewValue>>()
let revision = 0

/** Changes whenever any template's preview does, so a renderer can tell a settled frame cheaply. */
export const appearancePreviewRevision = (): number => revision

export const setAppearancePreview = <K extends PreviewKey>(
  id: string,
  property: K,
  value: Appearance[K],
): void => {
  const preview = previews.get(id) ?? new Map<PreviewKey, PreviewValue>()
  preview.set(property, value)
  previews.set(id, preview)
  revision++
}

export const clearAppearancePreview = <K extends PreviewKey>(
  id: string,
  property?: K,
  expected?: Appearance[K],
): void => {
  if (property === undefined) {
    if (previews.delete(id)) revision++
    return
  }
  const preview = previews.get(id)
  if (preview === undefined) return
  if (expected !== undefined && !Object.is(preview.get(property), expected)) return
  preview.delete(property)
  if (preview.size === 0) previews.delete(id)
  revision++
}

export const appearanceWithPreview = (id: string, appearance: Appearance): Appearance => {
  let result = appearance
  for (const [property, value] of previews.get(id) ?? []) {
    result = { ...result, [property]: value }
  }
  return result
}

export const hasAppearancePreview = (id: string): boolean => previews.has(id)
