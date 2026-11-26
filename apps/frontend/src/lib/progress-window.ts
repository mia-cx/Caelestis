import { type Manifest, type ProgressWindow, seconds } from '@caelestis/shared'

const inherited = (own: ProgressWindow | undefined, fallback: ProgressWindow): ProgressWindow => ({
  start: own?.start ?? fallback.start,
  end: own?.end ?? fallback.end,
})

const unbounded: ProgressWindow = { start: null, end: null }

export const resolveProgressWindows = (manifest: Manifest): ReadonlyMap<string, ProgressWindow> => {
  const nodes = new Map(manifest.nodes.map((node) => [node.id, node]))
  const configured = new Map<string, ProgressWindow>()
  const configuredFor = (id: string | null): ProgressWindow => {
    if (id === null) return unbounded
    const cached = configured.get(id)
    if (cached !== undefined) return cached
    const node = nodes.get(id)
    if (node === undefined) return unbounded
    const window = inherited(node.progressWindow, configuredFor(node.parentId))
    configured.set(id, window)
    return window
  }

  const templates = new Map<string, ProgressWindow>()
  const folders = new Map<string, ProgressWindow>()
  for (const template of manifest.templates) {
    const window = inherited(template.progressWindow, configuredFor(template.nodeId))
    templates.set(template.id, window)
    if (!template.published) continue
    for (let id = template.nodeId; id !== null; id = nodes.get(id)?.parentId ?? null) {
      const folder = folders.get(id) ?? unbounded
      folders.set(id, {
        start:
          folder.start === null || (window.start !== null && window.start < folder.start)
            ? window.start
            : folder.start,
        end:
          folder.end === null || (window.end !== null && window.end > folder.end)
            ? window.end
            : folder.end,
      })
    }
  }

  for (const template of manifest.templates) {
    let window = templates.get(template.id) ?? unbounded
    for (
      let id = template.nodeId;
      id !== null && (window.start === null || window.end === null);
      id = nodes.get(id)?.parentId ?? null
    ) {
      window = inherited(window, folders.get(id) ?? unbounded)
    }
    templates.set(template.id, window)
  }
  return templates
}

export const inProgressWindow = (at: number, window: ProgressWindow | undefined): boolean =>
  at >= (window?.start ?? -Infinity) && at < (window?.end ?? Infinity)

/** A shared tile can show any time covered by the outer bounds of its capturing templates. */
export const tileProgressWindow = (
  templates: readonly { readonly progressWindow?: ProgressWindow }[],
): ProgressWindow =>
  templates.reduce<ProgressWindow>(
    (tile, { progressWindow }) => ({
      start:
        tile.start === null || progressWindow?.start == null
          ? null
          : seconds(Math.min(tile.start, progressWindow.start)),
      end:
        tile.end === null || progressWindow?.end == null
          ? null
          : seconds(Math.max(tile.end, progressWindow.end)),
    }),
    templates[0]?.progressWindow ?? unbounded,
  )
